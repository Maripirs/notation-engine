// `notation-engine/examples`: ready-made showcase scores.
//
// Each `create*Score` builds a small `Score` in code that exercises one area
// of the engraving (durations, accidentals, chords, grace notes, a grand
// staff, ...), and `createFullDemoScore` strings most of them together. They
// are handy for trying the engine without a MusicXML file at hand, which is
// why they ship, but they are fixtures rather than API: their content may
// change between releases, so a host should not build on their exact shape.
// A separate entry keeps them out of the main bundle.

export * from './demo-score.js';
