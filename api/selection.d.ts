/** Value comparison for selected view snapshots. Identity is the fast path. Callers must
 * replace changed objects: mutating a published snapshot in place is unsupported. */
export declare function sameSelection(a: unknown, b: unknown): boolean;
/** Keyed delivery with selected-value equality. Reentrant notifications are drained after
 * the current pass; unsubscribing during delivery prevents a stale callback. */
export declare class SelectionHub {
    private entries;
    private pending;
    private delivering;
    subscribe(key: string | readonly string[], read: () => unknown, notify: () => void): () => void;
    notify(keys?: Iterable<string>): void;
}
