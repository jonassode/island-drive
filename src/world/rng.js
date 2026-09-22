/**
 * Deterministic, seedable pseudo random number generator.
 *
 * `mulberry32` returns an object exposing `random()`, which is the exact interface
 * `THREE.SimplexNoise` expects: it calls `r.random()` to fill its permutation table,
 * so passing a seeded PRNG makes the whole terrain reproducible.
 *
 * @param {number} seed Any integer. Non integers are truncated.
 * @returns {{ random: () => number, seed: number }} PRNG emitting numbers in [0, 1).
 */
export function mulberry32( seed ) {

	let state = ( Number( seed ) || 0 ) >>> 0;
	const normalized = state;

	function random() {

		state = ( state + 0x6D2B79F5 ) >>> 0;
		let t = state;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	}

	return { random, seed: normalized };

}

/**
 * Creates a random 32 bit seed.
 *
 * @param {number} [max] Exclusive upper bound.
 * @returns {number} A new seed.
 */
export function randomSeed( max = 2147483647 ) {

	return Math.floor( Math.random() * max );

}
