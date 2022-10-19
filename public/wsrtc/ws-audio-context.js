import {channelCount, sampleRate, bitrate} from './ws-constants.js';

let audioCtx = null;
let audioCtxPromise = null;
export const ensureAudioContext = () => {
  if (!audioCtxPromise) {
    audioCtxPromise = (async () => {
      audioCtx = new AudioContext({
        latencyHint: 'interactive',
        sampleRate,
      });
      await Promise.all([
        audioCtx.audioWorklet.addModule(`${import.meta.url.replace(/(\/)[^\/]*$/, '$1')}ws-input-worklet.js`),
        audioCtx.audioWorklet.addModule(`${import.meta.url.replace(/(\/)[^\/]*$/, '$1')}ws-output-worklet.js`),
      ]);
      return audioCtx;
    })();
  }
  return audioCtxPromise;
};
export const getAudioContext = () => {
  if (!audioCtxPromise) {
    throw new Error('need to call ensureAudioContext first');
  }
  return audioCtx;
};