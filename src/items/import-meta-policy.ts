/**
 * When to activate forever_items_meta after an import walk.
 * catalogIsActive() flips item_not_forever enforcement once build_id != 'empty'.
 * Partial (--only) or errorful full walks must not activate the catalog.
 */

export type CatalogMetaDecision =
  | { setMeta: true }
  | { setMeta: false; message: string };

export function decideCatalogMetaActivation(args: {
  /** True when the CLI was invoked with --only. */
  partialOnly: boolean;
  itemErrors: number;
}): CatalogMetaDecision {
  if (args.partialOnly) {
    return {
      setMeta: false,
      message:
        'REFUSING setMeta: --only partial import must not activate forever_items_meta (catalogIsActive / item_not_forever stays off until a clean full walk)',
    };
  }
  if (args.itemErrors > 0) {
    return {
      setMeta: false,
      message: `REFUSING setMeta: full walk completed with item_errors=${args.itemErrors}; leaving forever_items_meta inactive so item_not_forever stays off`,
    };
  }
  return { setMeta: true };
}
