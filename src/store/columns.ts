/**
 * Column widths for the download table.
 *
 * Behaves like Explorer's details view, which is the model people already have:
 * drag an edge to resize, double-click an edge to fit the column to its
 * content, and the Name column absorbs leftover space until you size it
 * yourself — after which it stays exactly where you put it.
 *
 * Widths persist to `localStorage` rather than to the settings database: they
 * are a property of this screen on this machine, not of the download queue, and
 * a round trip through the engine for every pixel of a drag would be absurd.
 */

import { create } from "zustand";

export type ColumnId =
  | "name"
  | "size"
  | "progress"
  | "speed"
  | "left"
  | "status"
  | "added"
  | "completed"
  | "source";

export const COLUMNS: {
  id: ColumnId;
  label: string;
  min: number;
  align?: "right";
  sortable: boolean;
  /** Off until asked for. Every column shown by default costs the Name column
   *  width, which is the one people actually read. */
  optional?: boolean;
}[] = [
  { id: "name", label: "Name", min: 140, sortable: true },
  { id: "size", label: "Size", min: 62, align: "right", sortable: true },
  { id: "progress", label: "Progress", min: 90, sortable: true },
  { id: "speed", label: "Speed", min: 62, align: "right", sortable: true },
  { id: "left", label: "Left", min: 56, align: "right", sortable: false },
  { id: "status", label: "Status", min: 80, sortable: true },
  { id: "added", label: "Added", min: 96, sortable: true },
  { id: "completed", label: "Finished", min: 96, sortable: true, optional: true },
  { id: "source", label: "Source", min: 90, sortable: false, optional: true },
];

/** Columns hidden until the user turns them on, from the header's own menu. */
const HIDDEN_BY_DEFAULT: ColumnId[] = COLUMNS.filter((c) => c.optional).map(
  (c) => c.id,
);

/** Fixed leading checkbox and trailing action cells; never resizable. */
export const GUTTER_LEAD = 28;
export const GUTTER_TRAIL = 76;
/** Horizontal gap between cells, mirrored in the grid's `gap`. */
export const COLUMN_GAP = 12;

export type Widths = Record<ColumnId, number>;

const DEFAULTS: Widths = {
  name: 300,
  size: 78,
  progress: 190,
  speed: 84,
  left: 70,
  status: 104,
  added: 118,
  completed: 118,
  source: 96,
};

/** Past this, extra width in the Name column stops buying readability. */
const NAME_COMFORTABLE = 560;
const PROGRESS_MIN = 150;
const PROGRESS_COMFORTABLE = 320;

const STORAGE_KEY = "downpour.columns.v1";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface Stored {
  widths: Widths;
  nameManual: boolean;
  /** Columns the user has switched off. Absent means "the defaults". */
  hidden: ColumnId[];
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        widths: { ...DEFAULTS },
        nameManual: false,
        hidden: [...HIDDEN_BY_DEFAULT],
      };
    }
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      // Merge over the defaults so a column added in a later version does not
      // arrive as `undefined` and collapse the grid.
      widths: { ...DEFAULTS, ...(parsed.widths ?? {}) },
      nameManual: Boolean(parsed.nameManual),
      // A layout saved before optional columns existed has no opinion about
      // them, so it gets the defaults rather than every new column switched on.
      hidden: Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((id): id is ColumnId =>
            COLUMNS.some((c) => c.id === id),
          )
        : [...HIDDEN_BY_DEFAULT],
    };
  } catch {
    return {
      widths: { ...DEFAULTS },
      nameManual: false,
      hidden: [...HIDDEN_BY_DEFAULT],
    };
  }
}

function persist(state: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A private window or full quota is not worth an error message over.
  }
}

interface ColumnState extends Stored {
  setWidth: (id: ColumnId, px: number) => void;
  /** Called while dragging; does not mark Name as manual until the drag ends. */
  resize: (id: ColumnId, px: number) => void;
  endResize: (id: ColumnId) => void;
  autoFit: (id: ColumnId, contentPx: number) => void;
  /** Shows or hides an optional column. Name is never hideable. */
  toggle: (id: ColumnId) => void;
  /** Gives Name whatever room the container has left over. */
  fitToContainer: (containerPx: number) => void;
  reset: () => void;
}

const initial = load();

export const useColumns = create<ColumnState>((set, get) => ({
  ...initial,

  setWidth(id, px) {
    const min = COLUMNS.find((c) => c.id === id)?.min ?? 60;
    const widths = { ...get().widths, [id]: Math.max(min, Math.round(px)) };
    const next = {
      widths,
      nameManual: id === "name" ? true : get().nameManual,
      hidden: get().hidden,
    };
    set(next);
    persist(next);
  },

  toggle(id) {
    // The Name column is the row's identity; hiding it would leave a table of
    // sizes and percentages belonging to nothing.
    if (id === "name") return;
    const { hidden, widths, nameManual } = get();
    const next = {
      widths,
      nameManual,
      hidden: hidden.includes(id)
        ? hidden.filter((h) => h !== id)
        : [...hidden, id],
    };
    set(next);
    persist(next);
  },

  resize(id, px) {
    const min = COLUMNS.find((c) => c.id === id)?.min ?? 60;
    set({ widths: { ...get().widths, [id]: Math.max(min, Math.round(px)) } });
  },

  endResize(id) {
    const state = {
      widths: get().widths,
      nameManual: id === "name" ? true : get().nameManual,
      hidden: get().hidden,
    };
    set(state);
    persist(state);
  },

  autoFit(id, contentPx) {
    const min = COLUMNS.find((c) => c.id === id)?.min ?? 60;
    // A little breathing room on the right, and a ceiling so one absurd
    // filename cannot push every other column off the screen.
    const px = Math.min(900, Math.max(min, Math.round(contentPx) + 24));
    const state = {
      widths: { ...get().widths, [id]: px },
      nameManual: id === "name" ? true : get().nameManual,
      hidden: get().hidden,
    };
    set(state);
    persist(state);
  },

  fitToContainer(containerPx) {
    if (get().nameManual) return;
    const { widths } = get();
    const fixed = COLUMNS.filter((c) => c.id !== "name" && c.id !== "progress").reduce(
      (sum, c) => sum + widths[c.id],
      0,
    );
    const gaps = COLUMN_GAP * (COLUMNS.length + 1);
    const slack = containerPx - GUTTER_LEAD - GUTTER_TRAIL - fixed - gaps;
    if (slack <= 0) return;

    // Split the free space between Name and Progress rather than handing it
    // all to Name. On a wide window an 1100px filename column next to a
    // 190px progress bar looks broken, and the bar is the thing people watch.
    const name = clamp(slack * 0.62, COLUMNS[0].min, NAME_COMFORTABLE);
    const progress = clamp(slack - name, PROGRESS_MIN, PROGRESS_COMFORTABLE);
    // Anything left after both are comfortable goes to Name, so the row still
    // reaches the right edge instead of leaving a dead gutter.
    const leftover = Math.max(0, slack - name - progress);

    const next = { ...widths, name: Math.round(name + leftover), progress: Math.round(progress) };
    if (next.name === widths.name && next.progress === widths.progress) return;
    set({ widths: next });
  },

  reset() {
    // Reset restores the default columns too -- a layout someone has given up
    // on includes whichever columns they switched on.
    const state = {
      widths: { ...DEFAULTS },
      nameManual: false,
      hidden: [...HIDDEN_BY_DEFAULT],
    };
    set(state);
    persist(state);
  },
}));

/** The `grid-template-columns` value both the header and every row use. */
/** The columns actually on screen, in order. */
export function visibleColumns(hidden: ColumnId[]) {
  return COLUMNS.filter((c) => !hidden.includes(c.id));
}

export function gridTemplate(widths: Widths, hidden: ColumnId[] = []): string {
  const middle = visibleColumns(hidden)
    .map((c) => `${widths[c.id]}px`)
    .join(" ");
  return `${GUTTER_LEAD}px ${middle} ${GUTTER_TRAIL}px`;
}

/**
 * Measures rendered text width without laying anything out.
 *
 * A hidden DOM node per row would be correct but costs a reflow for every
 * measurement; a canvas gives the same answer for a single-line, single-font
 * string and costs nothing.
 */
let ctx: CanvasRenderingContext2D | null = null;
export function measureText(text: string, font: string): number {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}
