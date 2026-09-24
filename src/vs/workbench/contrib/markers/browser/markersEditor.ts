/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, append, $, getActiveWindow } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { MarkerService } from '../../../../platform/markers/common/markerService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { EditorExtensions, EditorInputCapabilities, IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Markers } from '../common/markers.js';
import { IMarkersView } from './markers.js';
import { MarkersView } from './markersView.js';

interface IProblemsWindowState {
	title: string;
	source: string;
	message: string;
	/** LSP-shaped immutable compile result; isolated from the live Problems service. */
	snapshot: {
		generation: number;
		files: {
			uri: string; diagnostics: {
				message: string; severity?: number; code?: string | number; source?: string;
				range: { start: { line: number; character: number }; end: { line: number; character: number } };
				data?: { locationLabel?: string };
			}[];
		}[];
	};
}

class MarkersEditorInput extends EditorInput {
	static readonly ID = 'workbench.editor.problemsWindow';
	readonly resource = URI.from({ scheme: 'problems-window', path: '/problems' });
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeStatus = this.changed.event;
	readonly markerService = this._register(new MarkerService());
	constructor(public state: IProblemsWindowState) { super(); this.updateMarkers(); }
	override get typeId(): string { return MarkersEditorInput.ID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton; }
	override getName(): string { return this.state.title; }
	update(state: IProblemsWindowState): void {
		const snapshotChanged = this.state.snapshot.generation !== state.snapshot.generation;
		if (this.state.title === state.title && this.state.message === state.message && !snapshotChanged) { return; }
		const labelChanged = this.state.title !== state.title;
		this.state = state;
		if (snapshotChanged) { this.updateMarkers(); }
		if (labelChanged) { this._onDidChangeLabel.fire(); }
		this.changed.fire();
	}
	private updateMarkers(): void {
		const severities = [MarkerSeverity.Error, MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info, MarkerSeverity.Hint];
		this.markerService.changeAll(this.state.source, this.state.snapshot.files.flatMap(file =>
			file.diagnostics.map(diagnostic => ({
				resource: URI.parse(file.uri), marker: {
					message: diagnostic.message, source: diagnostic.source ?? this.state.source,
					severity: severities[diagnostic.severity ?? 1] ?? MarkerSeverity.Error,
					code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
					startLineNumber: diagnostic.range.start.line + 1, startColumn: diagnostic.range.start.character + 1,
					endLineNumber: diagnostic.range.end.line + 1, endColumn: diagnostic.range.end.character + 1,
					locationLabel: diagnostic.data?.locationLabel,
				}
			}))));
	}
}

/** Hosts the actual Problems view with the native marker service scoped to a saved snapshot. */
export class MarkersEditor extends EditorPane {
	static readonly ID = MarkersEditorInput.ID;
	private container!: HTMLElement;
	private message!: HTMLElement;
	private dimension = new Dimension(0, 0);
	private readonly view = this._register(new MutableDisposable<MarkersView>());
	private readonly statusListener = this._register(new MutableDisposable());
	private readonly viewServices = this._register(new MutableDisposable<IInstantiationService>());
	private editorContextKeys!: IContextKeyService;
	get markersView(): MarkersView | undefined { return this.view.value; }
	override get scopedContextKeyService(): IContextKeyService { return this.editorContextKeys; }

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
	) { super(MarkersEditor.ID, group, telemetryService, themeService, storageService); }

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.problems-window.monaco-pane-view'));
		this.message = append(this.container, $('.problems-window-status'));
		this.message.setAttribute('role', 'status');
		this.message.style.cssText = 'padding: 8px 12px; white-space: pre-wrap;';
		this.editorContextKeys = this._register(this.contextKeyService.createScoped(this.container));
		FocusedViewContext.bindTo(this.editorContextKeys).set(Markers.MARKERS_VIEW_ID);
	}

	override async setInput(input: MarkersEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) { return; }
		this.clearView();
		this.viewServices.value = this.instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, this.editorContextKeys], [IMarkerService, input.markerService]));
		this.view.value = this.viewServices.value.createInstance(MarkersView, {
			id: Markers.MARKERS_VIEW_ID, title: input.state.title,
			markerSource: input.state.source,
			storageId: `${Markers.MARKERS_VIEW_STORAGE_ID}.window.${input.state.source}`,
			openEditorGroup: sideBySide => {
				const main = this.groups.mainPart;
				return (sideBySide ? main.findGroup({ direction: GroupDirection.RIGHT }, main.activeGroup)
					?? main.addGroup(main.activeGroup, GroupDirection.RIGHT) : main.activeGroup).id;
			},
		});
		this.container.appendChild(this.view.value.element);
		this.view.value.render();
		this.view.value.setVisible(this.isVisible());
		const update = () => {
			this.message.textContent = input.state.message;
			this.message.hidden = !input.state.message;
			this.layout(this.dimension);
		};
		this.statusListener.value = input.onDidChangeStatus(update);
		update();
	}

	private clearView(): void {
		this.statusListener.clear();
		this.view.value?.saveState();
		this.view.value?.setVisible(false);
		this.view.value?.element.remove();
		this.view.clear();
		this.viewServices.clear();
	}
	override clearInput(): void { this.clearView(); super.clearInput(); }
	protected override setEditorVisible(visible: boolean): void { super.setEditorVisible(visible); this.view.value?.setVisible(visible); }
	override focus(): void { this.view.value?.focus(); }
	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
		const view = this.view.value;
		if (view) {
			const height = Math.max(0, dimension.height - this.message.offsetHeight);
			view.orthogonalSize = view.orientation === Orientation.HORIZONTAL ? height : dimension.width;
			view.layout(view.orientation === Orientation.HORIZONTAL ? dimension.width : height);
		}
	}
}

// Actions/keyboard shortcuts use the view in the focused editor window, otherwise
// the normal Problems panel. Both instances keep their own selection and filters.
export function getActiveMarkersView(accessor: ServicesAccessor): MarkersView | null {
	const pane = accessor.get(IEditorGroupsService).activeGroup.activeEditorPane;
	if (pane instanceof MarkersEditor && pane.window === getActiveWindow()) { return pane.markersView ?? null; }
	return accessor.get(IViewsService).getActiveViewWithId<MarkersView>(Markers.MARKERS_VIEW_ID);
}

export abstract class ProblemsViewAction extends ViewAction<IMarkersView> {
	override run(accessor: ServicesAccessor, ...args: unknown[]): unknown {
		const view = getActiveMarkersView(accessor);
		return view ? this.runInView(accessor, view, ...args) : undefined;
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(MarkersEditor, MarkersEditor.ID, localize('problemsWindow', 'Problems')),
	[new SyncDescriptor(MarkersEditorInput)],
);

let input: MarkersEditorInput | undefined;
let opening: Promise<void> | undefined;
CommandsRegistry.registerCommand('_workbench.problemsWindow', async (accessor, operation: string, state: IProblemsWindowState) => {
	const groups = accessor.get(IEditorGroupsService);
	if (operation === 'close') {
		const closing = input;
		input = undefined;
		if (closing) {
			for (const group of groups.groups) {
				if (group.contains(closing)) { await group.closeEditor(closing); }
			}
			closing.dispose();
		}
		return;
	}
	if (!state || typeof state.source !== 'string' || typeof state.title !== 'string' || typeof state.message !== 'string'
		|| !state.snapshot || !Array.isArray(state.snapshot.files)) { return; }
	if (input?.isDisposed()) { input = undefined; }
	if (input && input.state.source !== state.source) { return; }
	input?.update(state);
	if (operation !== 'show' && operation !== 'showIfClosed') { return; }
	if (opening) { return opening; }
	if (input) {
		const group = groups.groups.find(group => group.contains(input!));
		if (group) { if (operation === 'show') { await group.openEditor(input, { pinned: true }); group.focus(); } return; }
	}
	const current = input = new MarkersEditorInput(state);
	opening = (async () => {
		const part = await groups.createAuxiliaryEditorPart({ windowStateKey: `problems.${state.source}`, bounds: { width: 900, height: 560 } });
		if (current.isDisposed() || input !== current) { part.close(); return; }
		try {
			await part.activeGroup.openEditor(current, { pinned: true });
			if (!current.isDisposed()) { part.activeGroup.focus(); }
		} catch (error) {
			part.close();
			throw error;
		}
	})();
	try { await opening; } catch (error) {
		if (input === current) { input = undefined; }
		current.dispose();
		throw error;
	} finally { opening = undefined; }
});
