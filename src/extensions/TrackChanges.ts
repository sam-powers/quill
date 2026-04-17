import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { v4 as uuidv4 } from 'uuid';
import type { TrackedChangeInfo } from '../types';

export interface TrackChangesStorage {
  enabled: boolean;
  authorID: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      setTrackChangesEnabled: (enabled: boolean) => ReturnType;
      setTrackChangesAuthor: (authorID: string) => ReturnType;
      acceptChange: (id: string) => ReturnType;
      rejectChange: (id: string) => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
    };
  }
}

const TRACK_PLUGIN_KEY = new PluginKey<TrackChangesStorage>('trackChanges');
const SKIP_TRACKING_META = 'skipTracking';


export const TrackedInsert = Mark.create({
  name: 'tracked_insert',
  inclusive: true,
  excludes: 'tracked_delete',

  addAttributes() {
    return {
      dataTracked: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-tracked');
          try {
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => ({
          'data-tracked': JSON.stringify(attrs.dataTracked),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'ins[data-tracked]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'track-insert' }), 0];
  },
});

export const TrackedDelete = Mark.create({
  name: 'tracked_delete',
  inclusive: false,
  excludes: 'tracked_insert',

  addAttributes() {
    return {
      dataTracked: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-tracked');
          try {
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => ({
          'data-tracked': JSON.stringify(attrs.dataTracked),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'del[data-tracked]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'track-delete' }), 0];
  },
});

export const TrackChanges = Extension.create<TrackChangesStorage>({
  name: 'trackChanges',

  addStorage() {
    return {
      enabled: false,
      authorID: 'anonymous',
    };
  },

  addProseMirrorPlugins() {
    const ext = this;

    return [
      new Plugin({
        key: TRACK_PLUGIN_KEY,

        view(editorView) {
          const origDispatch = editorView.dispatch.bind(editorView);

          editorView.dispatch = function (tr) {
            const { enabled, authorID } = ext.storage as TrackChangesStorage;

            if (
              enabled &&
              tr.docChanged &&
              !tr.getMeta(SKIP_TRACKING_META) &&
              !tr.getMeta('history$')
            ) {
              const transformed = transformForTracking(tr, editorView.state, authorID);
              transformed.setMeta(SKIP_TRACKING_META, true);
              origDispatch(transformed);
            } else {
              origDispatch(tr);
            }
          };

          return {
            destroy() {
              editorView.dispatch = origDispatch;
            },
          };
        },
      }),
    ];
  },

  addCommands() {
    return {
      setTrackChangesEnabled:
        (enabled: boolean) =>
        () => {
          this.storage.enabled = enabled;
          return true;
        },

      setTrackChangesAuthor:
        (authorID: string) =>
        () => {
          this.storage.authorID = authorID;
          return true;
        },

      acceptChange:
        (id: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const positions: Array<{ from: number; to: number; operation: string }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (
                (mark.type === insertType || mark.type === deleteType) &&
                mark.attrs.dataTracked?.id === id
              ) {
                positions.push({
                  from: pos,
                  to: pos + node.nodeSize,
                  operation: mark.attrs.dataTracked.operation,
                });
              }
            });
          });

          // Process in reverse order to preserve positions
          positions.sort((a, b) => b.from - a.from);
          for (const { from, to, operation } of positions) {
            if (operation === 'insert') {
              tr.removeMark(from, to, insertType);
            } else {
              tr.delete(from, to);
            }
          }
          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },

      rejectChange:
        (id: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const positions: Array<{ from: number; to: number; operation: string }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (
                (mark.type === insertType || mark.type === deleteType) &&
                mark.attrs.dataTracked?.id === id
              ) {
                positions.push({
                  from: pos,
                  to: pos + node.nodeSize,
                  operation: mark.attrs.dataTracked.operation,
                });
              }
            });
          });

          positions.sort((a, b) => b.from - a.from);
          for (const { from, to, operation } of positions) {
            if (operation === 'insert') {
              tr.delete(from, to);
            } else {
              tr.removeMark(from, to, deleteType);
            }
          }
          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },

      acceptAllChanges:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const deletes: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending') {
                deletes.push({ from: pos, to: pos + node.nodeSize });
              }
            });
          });

          // Remove insert marks first
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === insertType && mark.attrs.dataTracked?.status === 'pending') {
                tr.removeMark(pos, pos + node.nodeSize, insertType);
              }
            });
          });

          // Delete the marked-for-deletion text in reverse order
          deletes.sort((a, b) => b.from - a.from);
          for (const { from, to } of deletes) {
            tr.delete(from, to);
          }

          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },

      rejectAllChanges:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const inserts: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === insertType && mark.attrs.dataTracked?.status === 'pending') {
                inserts.push({ from: pos, to: pos + node.nodeSize });
              }
            });
          });

          // Remove delete marks first
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending') {
                tr.removeMark(pos, pos + node.nodeSize, deleteType);
              }
            });
          });

          // Delete inserted text in reverse order
          inserts.sort((a, b) => b.from - a.from);
          for (const { from, to } of inserts) {
            tr.delete(from, to);
          }

          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },
    };
  },
});

export function getTrackedChanges(editor: { state: { doc: any; schema: any } }): TrackedChangeInfo[] {
  const { doc, schema } = editor.state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const changes = new Map<string, TrackedChangeInfo>();

  if (!insertType || !deleteType) return [];

  doc.descendants((node: any, pos: number) => {
    node.marks.forEach((mark: any) => {
      if ((mark.type === insertType || mark.type === deleteType) && mark.attrs.dataTracked) {
        const { id, operation, authorID, status, createdAt } = mark.attrs.dataTracked;
        if (!changes.has(id)) {
          changes.set(id, {
            id,
            operation,
            from: pos,
            to: pos + node.nodeSize,
            authorID,
            status,
            createdAt,
          });
        } else {
          const existing = changes.get(id)!;
          existing.to = Math.max(existing.to, pos + node.nodeSize);
        }
      }
    });
  });

  return Array.from(changes.values());
}

function transformForTracking(
  tr: import('@tiptap/pm/state').Transaction,
  state: import('@tiptap/pm/state').EditorState,
  authorID: string,
): import('@tiptap/pm/state').Transaction {
  const schema = state.schema;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];

  if (!insertType || !deleteType) return tr;

  const newTr = state.tr;
  // Track cumulative position offset: how many extra chars we've kept vs original
  let offset = 0;

  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) {
      // Non-replace step (mark steps, etc.) — apply as-is
      try {
        newTr.step(step);
      } catch {
        // Ignore steps that fail due to position shift
      }
      continue;
    }

    const rs = step as unknown as { from: number; to: number; slice: any };
    const from = rs.from + offset;
    const to = rs.to + offset;
    const slice = rs.slice;
    const hasDelete = from < to;
    const hasInsert = slice && slice.size > 0;

    const id = uuidv4();
    const dataTrackedBase = {
      id,
      authorID,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (hasDelete) {
      // Mark the range for deletion rather than deleting it
      newTr.addMark(
        from,
        to,
        deleteType.create({ dataTracked: { ...dataTrackedBase, operation: 'delete' } }),
      );
      // We kept the deleted text, so future positions are offset by (to - from)
      offset += to - from;
    }

    if (hasInsert) {
      // Insert at the position AFTER the kept deleted range
      const insertAt = to; // `to` already includes the kept deletion range
      newTr.insert(insertAt, slice.content);
      const insertEnd = insertAt + slice.content.size;
      newTr.addMark(
        insertAt,
        insertEnd,
        insertType.create({ dataTracked: { ...dataTrackedBase, operation: 'insert' } }),
      );
    }
  }

  // Set cursor to end of last insert or at `from` of last delete
  const lastStep = tr.steps[tr.steps.length - 1];
  if (lastStep instanceof ReplaceStep) {
    const rs = lastStep as unknown as { from: number; to: number; slice: any };
    const hasInsert = rs.slice && rs.slice.size > 0;
    if (hasInsert) {
      const insertAt = rs.to + offset - (rs.to - rs.from);
      try {
        const sel = state.selection.constructor as any;
        if (sel.near) {
          newTr.setSelection(sel.near(newTr.doc.resolve(insertAt + rs.slice.size)));
        }
      } catch {
        // Keep default selection
      }
    }
  }

  return newTr;
}
