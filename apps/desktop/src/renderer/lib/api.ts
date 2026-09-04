/**
 * The bridge, where the design's components expect to find it.
 *
 * `../api.js` remains the only definition - this is a re-export so the ported
 * components can keep their own import style without a second copy of the
 * bridge existing.
 */
export { api, messageOf } from '../api.js';
