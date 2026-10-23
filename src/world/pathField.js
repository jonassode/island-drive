/**
 * Procedural dirt path: one closed loop laid around the island.
 *
 * Pure module — no DOM, no WebGL, no `three` — so it runs headless under Vitest and stays
 * the single source of truth for where the path is: {@link ./path.js} builds the visible
 * ribbon from `points`, and `isOnPath()` answers "is this on the track?" for anything else
 * that wants to know.
 *
 * The loop is stored in polar form: a radius that varies with the angle, where every term
 * is a sine of an *integer multiple* of the angle. That buys three things at once:
 *
 * 1. it closes on itself exactly — `sin(k * 0)` and `sin(k * 2 pi)` are the same number, so
 *    the loop cannot end in a seam or a short segment,
 * 2. it can never cross itself, because the radius is a single valued function of the angle,
 * 3. it is smooth everywhere, unlike a ring of jittered sample points.
 *
 * `PATH.radius` is a fraction of the island radius rather than a distance, so the path stays
 * on the island's flank whatever `WORLD.islandRadius` is set to.
 */

import { mulberry32 } from './rng.js';
import { PATH } from '../config.js';

/** Own PRNG stream, so the path cannot shift when another system draws different numbers. */
const PATH_STREAM = 0x5EE1A7;
/** Two pi. */
const TAU = Math.PI * 2;

/**
 * Sums a set of `sin(k * angle + phase)` harmonics.
 *
 * @param {Array<{k: number, amplitude: number, phase: number}>} harmonics Harmonics to sum.
 * @param {number} angle Angle in radians.
 * @returns {number} The summed wobble.
 */
function sumHarmonics( harmonics, angle ) {

	let sum = 0;

	for ( let i = 0; i < harmonics.length; i ++ ) {

		const harmonic = harmonics[ i ];
		sum += harmonic.amplitude * Math.sin( harmonic.k * angle + harmonic.phase );

	}

	return sum;

}

/**
 * Creates the path's centreline.
 *
 * @param {object} heightField The terrain the path is laid on; its radius and seed drive the
 *   loop. Only `radius` and `seed` are read — no terrain sampling happens here.
 * @param {object} [options] Overrides for {@link PATH}.
 * @returns {{seed: number, radius: number, halfWidth: number, length: number, points: Array<object>,
 *   pointCount: number, radiusAt: Function, halfWidthAt: Function, distanceFromPath: Function,
 *   isOnPath: Function}} The path field.
 */
export function createPathField( heightField, options = {} ) {

	const config = { ...PATH, ...options };
	const rng = mulberry32( ( heightField.seed ?? 0 ) ^ PATH_STREAM );

	// Every harmonic gets a random phase and a random share of its configured amplitude, so
	// two islands do not merely rotate the same outline past each other.
	const wobble = config.wobble.map( ( harmonic ) => ( {
		k: harmonic.k,
		amplitude: harmonic.amplitude * ( 0.6 + rng.random() * 0.8 ),
		phase: rng.random() * TAU,
	} ) );

	const widthWobble = config.widthWobble.map( ( harmonic ) => ( {
		k: harmonic.k,
		amplitude: harmonic.amplitude,
		phase: rng.random() * TAU,
	} ) );

	/** Nominal radius of the loop, before the wobble. */
	const nominalRadius = config.radius * heightField.radius;

	/**
	 * Radius of the loop at an angle.
	 *
	 * @param {number} angle Angle in radians.
	 * @returns {number} Distance from the island centre, in world units.
	 */
	function radiusAt( angle ) {

		return nominalRadius * ( 1 + sumHarmonics( wobble, angle ) );

	}

	/**
	 * Half width of the trodden dirt at an angle.
	 *
	 * @param {number} angle Angle in radians.
	 * @returns {number} Half width in world units.
	 */
	function halfWidthAt( angle ) {

		return config.halfWidth * ( 1 + config.widthVariation * sumHarmonics( widthWobble, angle ) );

	}

	// The stations around the loop. The last one is a full step short of the first: the loop
	// is closed by wrapping the index back to 0 (that is what `path.js` does when it builds
	// the ribbon), so duplicating a station here would only make zero-area triangles.
	const points = [];

	for ( let i = 0; i < config.segments; i ++ ) {

		const angle = ( i / config.segments ) * TAU;
		const radius = radiusAt( angle );

		points.push( {
			angle,
			radius,
			x: Math.cos( angle ) * radius,
			z: Math.sin( angle ) * radius,
			/** Half width here, so the ribbon builder does not have to re-derive it. */
			width: halfWidthAt( angle ),
		} );

	}

	let length = 0;

	for ( let i = 0; i < points.length; i ++ ) {

		const point = points[ i ];
		const next = points[ ( i + 1 ) % points.length ];

		length += Math.hypot( next.x - point.x, next.z - point.z );

	}

	/**
	 * Distance from a world position to the loop's centreline.
	 *
	 * Measured radially (the difference between the position's own radius and the loop's
	 * radius at that bearing) rather than as a true point-to-curve distance. On a loop this
	 * gently curved the two agree to well under a path width, and this version is exact at
	 * the centreline and cheap enough to call from anywhere.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @returns {number} Distance in world units, never negative.
	 */
	function distanceFromPath( x, z ) {

		return Math.abs( Math.hypot( x, z ) - radiusAt( Math.atan2( z, x ) ) );

	}

	/**
	 * Whether a world position is on the trodden dirt.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @param {number} [margin] Extra width to accept, in world units.
	 * @returns {boolean} True when the position is on the path.
	 */
	function isOnPath( x, z, margin = 0 ) {

		return distanceFromPath( x, z ) <= halfWidthAt( Math.atan2( z, x ) ) + margin;

	}

	return {
		seed: heightField.seed,
		/** Nominal radius of the loop, before the wobble. */
		radius: nominalRadius,
		halfWidth: config.halfWidth,
		/** Perimeter of the loop, in world units. */
		length,
		/** The closed centreline: `segments` stations, wrapping back to index 0. */
		points,
		pointCount: points.length,
		radiusAt,
		halfWidthAt,
		distanceFromPath,
		isOnPath,
	};

}