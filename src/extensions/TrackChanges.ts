import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import type { Node as ProseMirrorNode, Schema, Slice } from '@tiptap/pm/model';
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
      changeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-change-id'),
        renderHTML: (attrs) => (attrs.changeId ? { 'data-change-id': attrs.changeId } : {}),
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
      changeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-change-id'),
        renderHTML: (attrs) => (attrs.changeId ? { 'data-change-id': attrs.changeId } : {}),
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
    // Read the extension's live storage lazily so dispatch always sees the
    // current enabled/authorID rather than a snapshot. An arrow keeps `this`
    // bound without aliasing it to a local (which no-this-alias forbids).
    const getStorage = () => this.storage as TrackChangesStorage;

    return [
      new Plugin({
        key: TRACK_PLUGIN_KEY,

        view(editorView) {
          const origDispatch = editorView.dispatch.bind(editorView);

          editorView.dispatch = function (tr) {
            const { enabled, authorID } = getStorage();

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
              // When tracking is disabled, make sure tracked marks aren't
              // inherited from the cursor's stored marks (which would happen
              // when typing immediately after existing <ins>/<del>).
              if (!enabled && tr.docChanged && !tr.getMeta(SKIP_TRACKING_META)) {
                const schema = editorView.state.schema;
                const insertType = schema.marks['tracked_insert'];
                const deleteType = schema.marks['tracked_delete'];
                const stored = tr.storedMarks ?? editorView.state.storedMarks;
                if (stored && stored.some((m) => m.type === insertType || m.type === deleteType)) {
                  tr.setStoredMarks(
                    stored.filter((m) => m.type !== insertType && m.type !== deleteType),
                  );
                }
                // Also strip tracked marks from any text the transaction just
                // inserted (cursor at the boundary of a marked region inherits
                // those marks even without storedMarks).
                tr.steps.forEach((step, i) => {
                  const map = tr.mapping.maps[i];
                  map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                    if (newEnd > newStart) {
                      tr.removeMark(newStart, newEnd, insertType);
                      tr.removeMark(newStart, newEnd, deleteType);
                    }
                  });
                  void step;
                });
              }
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
      setTrackChangesEnabled: (enabled: boolean) => () => {
        this.storage.enabled = enabled;
        return true;
      },

      setTrackChangesAuthor: (authorID: string) => () => {
        this.storage.authorID = authorID;
        return true;
      },

      // `id` may be a change id or a pairId: passing a replacement's pairId
      // resolves both halves in one transaction (a single undo step).
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
                (mark.attrs.dataTracked?.id === id || mark.attrs.dataTracked?.pairId === id)
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
                (mark.attrs.dataTracked?.id === id || mark.attrs.dataTracked?.pairId === id)
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

export function getTrackedChanges(editor: {
  state: { doc: ProseMirrorNode; schema: Schema };
}): TrackedChangeInfo[] {
  const { doc, schema } = editor.state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const changes = new Map<string, TrackedChangeInfo>();

  if (!insertType || !deleteType) return [];

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;
    // Each text node contributes its text at most once per tracked id, even if
    // the same id appears on multiple marks (defensive against stacked marks).
    const seen = new Set<string>();
    for (const mark of node.marks) {
      if (mark.type !== insertType && mark.type !== deleteType) continue;
      if (!mark.attrs.dataTracked) continue;
      const { id, operation, authorID, status, createdAt, pairId } = mark.attrs.dataTracked;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!changes.has(id)) {
        changes.set(id, {
          id,
          operation,
          from: pos,
          to: pos + node.nodeSize,
          text: node.text ?? '',
          authorID,
          status,
          createdAt,
          ...(pairId ? { pairId } : {}),
        });
      } else {
        const existing = changes.get(id)!;
        existing.to = Math.max(existing.to, pos + node.nodeSize);
        existing.text += node.text ?? '';
      }
    }
  });

  return Array.from(changes.values());
}

// Return the existing pending dataTracked object to reuse for the current edit,
// so consecutive edits by the same author coalesce into one suggestion card AND
// produce mark instances that compare equal (so PM merges adjacent text nodes
// instead of stacking N marks per character).
//
// Checks (in priority order):
//   1. Marks on text nodes inside the deleted range (replacement / continued delete).
//   2. The text node immediately before rs.from (typing forward / backspace).
//   3. The text node immediately after rs.to (delete-forward / continued delete).
type DataTracked = {
  id: string;
  operation: 'insert' | 'delete';
  authorID: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Shared by the delete and insert halves of a replacement (one ReplaceStep
   * that both removes and adds text), so the UI can present them as a single
   * "Replace old → new" suggestion resolved atomically.
   */
  pairId?: string;
};

function adjacentTracked(
  doc: import('@tiptap/pm/model').Node,
  from: number,
  to: number,
  insertType: import('@tiptap/pm/model').MarkType,
  deleteType: import('@tiptap/pm/model').MarkType,
  authorID: string,
  wantOperation: 'insert' | 'delete',
): DataTracked | null {
  function pendingTracked(node: import('@tiptap/pm/model').Node): DataTracked | null {
    for (const m of node.marks) {
      if (
        (m.type === insertType || m.type === deleteType) &&
        m.attrs.dataTracked?.status === 'pending' &&
        m.attrs.dataTracked?.authorID === authorID &&
        m.attrs.dataTracked?.operation === wantOperation
      ) {
        return m.attrs.dataTracked as DataTracked;
      }
    }
    return null;
  }

  try {
    if (from < to) {
      let found: DataTracked | null = null;
      doc.nodesBetween(from, to, (node) => {
        if (found || !node.isText) return;
        found = pendingTracked(node);
      });
      if (found) return found;
    }

    if (from > 0) {
      const $from = doc.resolve(from);
      const before = $from.nodeBefore;
      if (before?.isText) {
        const t = pendingTracked(before);
        if (t) return t;
      }
    }

    if (to < doc.content.size) {
      const $to = doc.resolve(to);
      const after = $to.nodeAfter;
      if (after?.isText) {
        const t = pendingTracked(after);
        if (t) return t;
      }
    }
  } catch {
    // ignore resolve errors near document boundaries
  }

  return null;
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
  let offset = 0;
  let lastDeleteLeftmost: number | null = null;
  let lastInsertEnd: number | null = null;

  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) {
      try {
        newTr.step(step);
      } catch {
        // ignore steps that fail due to position shift
      }
      continue;
    }

    const rs = step as unknown as { from: number; to: number; slice: Slice };
    const slice = rs.slice;
    const hasDelete = rs.from < rs.to;
    const hasInsert = slice && slice.size > 0;
    const offsetBefore = offset;

    // Reuse an existing pending change by this author if one is adjacent/inside,
    // otherwise mint a fresh dataTracked below. Returning the SAME object
    // reference means PM's Mark.eq() merges text nodes instead of stacking marks.
    const existingDelete = hasDelete
      ? adjacentTracked(state.doc, rs.from, rs.to, insertType, deleteType, authorID, 'delete')
      : null;
    const existingInsert = hasInsert
      ? adjacentTracked(state.doc, rs.from, rs.to, insertType, deleteType, authorID, 'insert')
      : null;

    // A step that both deletes and inserts is a replacement (typing over a
    // selection, or an applied quill-edit). Pair the halves so the UI shows one
    // card: two fresh halves share a new pairId, and a fresh half joining a
    // reused one adopts its pairId (extending an in-progress replacement). A
    // reused half that was never part of a pair stays unpaired — two cards,
    // matching how those changes began.
    const pairId =
      hasDelete && hasInsert
        ? (existingDelete?.pairId ??
          existingInsert?.pairId ??
          (!existingDelete && !existingInsert ? uuidv4() : undefined))
        : undefined;

    if (hasDelete) {
      const deleteTracked: DataTracked = existingDelete ?? {
        id: uuidv4(),
        operation: 'delete',
        authorID,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(pairId ? { pairId } : {}),
      };

      const insertRanges: Array<{ from: number; to: number }> = [];
      const normalRanges: Array<{ from: number; to: number }> = [];

      state.doc.nodesBetween(rs.from, rs.to, (node, pos) => {
        if (!node.isText) return;
        const nodeFrom = Math.max(pos, rs.from);
        const nodeTo = Math.min(pos + node.nodeSize, rs.to);
        if (nodeFrom >= nodeTo) return;
        const hasPendingInsert = node.marks.some(
          (m) => m.type === insertType && m.attrs.dataTracked?.status === 'pending',
        );
        const hasPendingDelete = node.marks.some(
          (m) => m.type === deleteType && m.attrs.dataTracked?.status === 'pending',
        );
        if (hasPendingInsert) {
          insertRanges.push({ from: nodeFrom + offset, to: nodeTo + offset });
        } else if (hasPendingDelete) {
          // Already marked as a pending delete — skip re-marking, but we still
          // want the cursor to move past it so the next backspace targets the
          // character before this range.
        } else {
          normalRanges.push({ from: nodeFrom + offset, to: nodeTo + offset });
        }
      });

      for (const r of normalRanges) {
        newTr.addMark(
          r.from,
          r.to,
          deleteType.create({ dataTracked: deleteTracked, changeId: deleteTracked.id }),
        );
      }

      insertRanges.sort((a, b) => b.from - a.from);
      for (const r of insertRanges) {
        newTr.delete(r.from, r.to);
      }

      const insertSize = insertRanges.reduce((sum, r) => sum + (r.to - r.from), 0);

      if (insertRanges.length === 0 && normalRanges.length === 0) {
        // Either: pure block-boundary deletion (e.g. backspace at start of
        // paragraph to merge lines), or: the entire range was already a
        // pending tracked_delete (consecutive backspaces against marked text).
        // For block-boundary: apply the step untracked.
        // For already-marked: just move the cursor — don't re-apply the step,
        // which would actually remove the kept-deleted text.
        const anyAlreadyDeleted = (() => {
          let found = false;
          state.doc.nodesBetween(rs.from, rs.to, (node) => {
            if (!node.isText) return;
            if (
              node.marks.some(
                (m) => m.type === deleteType && m.attrs.dataTracked?.status === 'pending',
              )
            ) {
              found = true;
            }
          });
          return found;
        })();
        if (!anyAlreadyDeleted) {
          try {
            newTr.step(step);
          } catch {
            // ignore
          }
        }
      } else {
        // The kept (delete-marked) text stays in the doc; the inserted-then-deleted
        // text actually shrinks the doc. Offset shifts by the shrink amount.
        offset -= insertSize;
      }

      // Leftmost position the cursor should land at: the start of the deleted
      // range, mapped into new-doc coordinates using the offset BEFORE this
      // step shrank the doc. That keeps the cursor inside the paragraph when
      // an entire inserted suggestion is removed (e.g. backspacing through
      // an <ins>aaa</ins> sequence to nothing).
      lastDeleteLeftmost = rs.from + offsetBefore;
    }

    if (hasInsert) {
      const insertTracked: DataTracked = existingInsert ?? {
        id: uuidv4(),
        operation: 'insert',
        authorID,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(pairId ? { pairId } : {}),
      };

      const insertAt = rs.from + offset;
      const isStructural = (slice.openStart ?? 0) > 0 || (slice.openEnd ?? 0) > 0;
      const docSizeBefore = newTr.doc.content.size;

      if (isStructural) {
        // Block split (Enter) or other structural change: respect the slice's
        // open boundaries by using replace, not insert. Insert(content) would
        // splat the raw fragment in and leave extra empty blocks behind.
        newTr.replace(insertAt, insertAt, slice);
      } else {
        newTr.insert(insertAt, slice.content);
      }

      const inserted = newTr.doc.content.size - docSizeBefore;
      const insertEnd = insertAt + inserted;
      // Only mark text content (skip block-split boundaries — there's no text
      // there to mark and addMark over block boundaries would crash).
      if (!isStructural && inserted > 0) {
        newTr.addMark(
          insertAt,
          insertEnd,
          insertType.create({ dataTracked: insertTracked, changeId: insertTracked.id }),
        );
      }
      offset += inserted;
      lastInsertEnd = insertEnd;
    }
  }

  // Place cursor:
  //  - End of last inserted text (insert / replace operations)
  //  - Start of last deleted range (pure delete, e.g. backspace) — so the
  //    next backspace targets the character to the left of the just-marked
  //    range instead of re-marking the same character.
  const lastStep = tr.steps[tr.steps.length - 1];
  if (lastStep instanceof ReplaceStep) {
    const rs = lastStep as unknown as { from: number; to: number; slice: Slice };
    const hasInsert = rs.slice && rs.slice.size > 0;
    try {
      if (hasInsert) {
        const insertEnd = lastInsertEnd ?? rs.from + offset;
        newTr.setSelection(TextSelection.create(newTr.doc, insertEnd));
      } else if (lastDeleteLeftmost !== null) {
        newTr.setSelection(TextSelection.create(newTr.doc, lastDeleteLeftmost));
      }
    } catch {
      // keep default selection
    }
  }

  return newTr;
}
