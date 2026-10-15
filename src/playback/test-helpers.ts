// Shared by the playback tests and `mountScore`'s lifecycle tests.

/** A minimal `AudioContext` stub with a settable `currentTime`. Every
 *  oscillator created is recorded, with the times its `stop()` was called,
 *  and `close()` calls are counted. */
export function mockAudioContext() {
	let currentTime = 0;
	let closeCalls = 0;
	const oscillators: { stoppedAt: number[] }[] = [];
	const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
	const audioContext = {
		get currentTime() {
			return currentTime;
		},
		destination: {},
		createOscillator() {
			const osc = {
				type: '',
				frequency: { ...param },
				stoppedAt: [] as number[],
				connect() {},
				start() {},
				stop(when: number) {
					osc.stoppedAt.push(when);
				}
			};
			oscillators.push(osc);
			return osc;
		},
		createGain() {
			return { gain: { ...param }, connect() {} };
		},
		resume: async () => {},
		close: async () => {
			closeCalls++;
		}
	};
	return {
		audioContext: audioContext as unknown as AudioContext,
		setCurrentTime: (value: number) => (currentTime = value),
		oscillators,
		closeCalls: () => closeCalls
	};
}
