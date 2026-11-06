/** Blizzard Forever static item / media / search shapes (subset). */

export type BlizzardItemQuality = { type: string; name?: string };
export type BlizzardInventoryType = { type: string; name?: string };
export type BlizzardItemClass = { id?: number; name?: string };
export type BlizzardItemSubclass = { id?: number; name?: string };

export type BlizzardPreviewStat = {
  type?: { type?: string; name?: string };
  value?: number;
};

export type BlizzardPlayableClassLink = {
  id?: number;
  name?: string;
};

export type BlizzardItem = {
  id: number;
  name?: string;
  quality?: BlizzardItemQuality;
  level?: number;
  required_level?: number;
  inventory_type?: BlizzardInventoryType;
  item_class?: BlizzardItemClass;
  item_subclass?: BlizzardItemSubclass;
  preview_item?: {
    stats?: BlizzardPreviewStat[];
    level?: { value?: number };
    require?: { level?: { value?: number } };
    requirements?: {
      level?: { value?: number; display_string?: string };
      playable_classes?: {
        links?: BlizzardPlayableClassLink[];
        display_string?: string;
      };
    };
    set?: {
      item_set?: { id?: number; name?: string };
      items?: Array<{ item?: { id?: number; name?: string }; id?: number }>;
      effects?: Array<{ display_string?: string; required_count?: number }>;
      display_string?: string;
    };
  };
};

export type BlizzardItemSetIndex = {
  item_sets?: Array<{ id: number; name?: string }>;
};

export type BlizzardItemSet = {
  id: number;
  name?: string;
  items?: Array<{ id?: number; name?: string }>;
  effects?: Array<{ display_string?: string; required_count?: number }>;
};

export type BlizzardItemMedia = {
  assets?: Array<{ key?: string; value?: string }>;
};

export type BlizzardItemSearchResult = {
  data?: {
    id?: number;
    name?: { en_US?: string } | string;
    inventory_type?: { type?: string };
    quality?: { type?: string };
    level?: number;
    required_level?: number;
    item_class?: { id?: number };
    item_subclass?: { id?: number };
  };
};

export type BlizzardItemSearchPage = {
  page?: number;
  pageSize?: number;
  maxPageSize?: number;
  pageCount?: number;
  results?: BlizzardItemSearchResult[];
};
