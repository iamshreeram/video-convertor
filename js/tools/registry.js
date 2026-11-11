/**
 * Tool catalogue for the sidebar. Only ready tools have a module to load;
 * 'soon' items are shown disabled and never routed to.
 * @type {Array<{id: string, group: string, title: string, subtitle: string, status: 'ready'|'soon', load?: () => Promise<object>}>}
 */
export const tools = [
  {
    id: "mkv-to-mp4",
    group: "Video",
    title: "MKV \u2192 MP4",
    subtitle: "Remux without re-encoding",
    status: "ready",
    load: () => import("./mkv-to-mp4.js"),
  },
  {
    id: "mov-to-mp4",
    group: "Video",
    title: "MOV \u2192 MP4",
    subtitle: "Coming next",
    status: "soon",
  },
  {
    id: "extract-audio",
    group: "Video",
    title: "Extract audio",
    subtitle: "Coming next",
    status: "soon",
  },
  {
    id: "trim-merge",
    group: "Video",
    title: "Trim & merge",
    subtitle: "Coming next",
    status: "soon",
  },
];

/** Tool opened when the hash is empty, unknown or points at a 'soon' item. */
export const defaultToolId = "mkv-to-mp4";
