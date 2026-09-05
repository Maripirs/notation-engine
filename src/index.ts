// Public API.
//
// Three layers, exported as one flat surface. `model` is the editable score and
// knows nothing about drawing; `layout` turns a score into positioned drawing
// operations and knows nothing about a canvas; `render` executes those
// operations against a `CanvasRenderingContext2D`. Nothing in any of the three
// touches a UI framework, so a Svelte/React/plain-DOM host is a thin wrapper
// that owns events and calls in. See README.md for the design principles.
//
// Phase 0 scope: one staff, one voice, standard undotted durations, one clef,
// one key and time signature, and a single edit op. The roadmap beyond that
// lives in Divisi's OMR_EDITOR_PLAN.md, milestone E13.

export const NOTATION_ENGINE_VERSION = '0.0.1';

export { createDemoScore, createDurationShowcaseScore, createFullDemoScore } from './demo-score.js';
export * from './model/index.js';
export * from './layout/index.js';
export * from './render/index.js';
