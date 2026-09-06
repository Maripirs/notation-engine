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
	TimeSignature
} from './score.js';
export {
	buildScore,
	Measure,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
	Score,
	Staff,
	validateMeasure
} from './score.js';
