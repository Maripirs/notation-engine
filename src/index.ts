// Public API.
//
// Five layers, plus a convenience layer on top, exported as one flat surface. `model` is the editable score and
// knows nothing about drawing; `layout` turns a score into positioned drawing
// operations and knows nothing about a canvas; `render` executes those
// operations against a `CanvasRenderingContext2D`; `playback` turns model
// durations and tempo into wall-clock timing and knows nothing about drawing
// or a canvas either; `io` turns the model to and from MusicXML, depends only
// on `model` (plus two pure beam-grouping helpers from `layout`, a deliberate
// reviewed exception noted in `io/musicxml-export.ts`), and knows nothing
// about a canvas. Nothing in any of the five touches a UI framework, so a
// Svelte/React/plain-DOM host is a thin wrapper that owns events and calls in.
// `view` is that wrapper for the common case: `mountScore` owns a canvas in a
// host element and wires scrolling, resizing, zoom and playback with a moving
// cursor. It is the only layer that touches the DOM, `ResizeObserver` or
// `AudioContext`, and it builds only on the five layers' public functions.
// See README.md for the design principles. Ready-made showcase scores live in
// a separate entry, `notation-engine/examples` (`src/examples.ts`). What is
// supported so far, and what is not yet, is tracked in plan.md.

/** The package version, injected from `package.json` at build time. */
export const NOTATION_ENGINE_VERSION: string = __NOTATION_ENGINE_VERSION__;

export * from './model/index.js';
export * from './layout/index.js';
export * from './render/index.js';
export * from './playback/index.js';
export * from './io/index.js';
export * from './view/index.js';
