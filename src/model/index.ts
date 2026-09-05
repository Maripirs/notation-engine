export type { Pitch, Step } from './pitch.js';
export {
	diatonicIndex,
	formatPitch,
	fromMidi,
	keyAlterForStep,
	parsePitch,
	pitchesEqual,
	toMidi,
	transpose
} from './pitch.js';

export type {
	MeasureSpec,
	NoteId,
	NoteSpec,
	NoteValue,
	ScoreOptions,
	Slur,
	SlurSpec,
	TimeSignature
} from './score.js';
export { buildScore, Measure, Note, NOTE_VALUE_WHOLES, Score } from './score.js';
