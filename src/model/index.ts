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
	BarlineType,
	ClefChange,
	ClefType,
	CrossStaffBeam,
	MeasureSpec,
	MeasureValidation,
	NoteId,
	NoteSpec,
	NoteValue,
	Part,
	ScoreOptions,
	Slur,
	SlurSpec,
	TimeSignature,
	TupletRatio
} from './score.js';
export { assertScoresEquivalent } from './score-equivalence.js';
export type { Fraction, MeasurePassthrough, OpaqueElement } from './passthrough.js';
export { NO_PASSTHROUGH, opaqueElementKey } from './passthrough.js';
export { EditHistory } from './edit-history.js';
export type { EditHistoryOptions } from './edit-history.js';
export {
	buildScore,
	Measure,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
	NO_CLEF_CHANGES,
	noteEvents,
	Score,
	Staff,
	validateMeasure
} from './score.js';
