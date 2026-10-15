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
	Articulation,
	BarlineType,
	ClefChange,
	ClefType,
	CrossStaffBeam,
	Fermata,
	GraceNote,
	GraceRun,
	MeasureSpec,
	MeasureValidation,
	NoteId,
	NoteSpec,
	MeasureRef,
	NoteValue,
	Part,
	SpelledDuration,
	ScoreOptions,
	Slur,
	SlurSpec,
	TimeSignature,
	TupletRatio,
	WedgeSpec
} from './score.js';
export type {
	DirectionSource,
	DynamicKind,
	DynamicMark,
	Placement,
	Wedge,
	WedgeEnd,
	WedgeKind
} from './directions.js';
export { DYNAMIC_KINDS, NO_DYNAMICS, positionBefore, sortDynamics } from './directions.js';
export { assertScoresEquivalent } from './score-equivalence.js';
export type { Fraction, MeasurePassthrough, OpaqueElement } from './passthrough.js';
export { NO_PASSTHROUGH, opaqueElementKey, withoutNoteMarkup, withoutTieMarkup } from './passthrough.js';
export { EditHistory } from './edit-history.js';
export type { EditHistoryOptions } from './edit-history.js';
export {
	ACCIACCATURA,
	APPOGGIATURA,
	ARTICULATIONS,
	buildScore,
	eventArticulations,
	eventFermata,
	graceRuns,
	Measure,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
	NOTE_VALUES,
	noteValueForWholes,
	restValuesFor,
	spelledWholes,
	NO_ARTICULATIONS,
	NO_CLEF_CHANGES,
	normalizeArticulations,
	noteEvents,
	Score,
	Staff,
	validateMeasure
} from './score.js';
