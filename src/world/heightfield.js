/**
 * Procedural island height field.
 *
 * This module is intentionally free of any DOM / WebGL / `THREE.Mesh` dependency so it
 * can run headless under Vitest. It is the single source of truth for the terrain: the
 * visible mesh ({@link ./island.js}) and the car's ground following both sample
 * `heightAt()`, so the car can never disagree with the rendered ground.
 *
 * The island is built from three parts:
 *
 * 1. a flat interior plateau (`baseHeight`),
 * 2. a set of seeded random hills scattered across it — the island's shape comes from
 *    these rather than from one central bump, so it has many separate climbs and crests,
 * 3. a little fractal detail, all of it multiplied by a radial falloff that sinks the
 *    edges below sea level.
 *
 * Because the hills are data rather than pure noise, the height field can report where
 * they are, and the tests can assert that they really are spread across the island.
 */

import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mulberry32 } from './rng.js';
import { WORLD } from '../config.js';

/** Step used for the analytic finite difference of the terrain normal. */
const NORMAL_EPSILON = 0.6;
/** Spawn search: how many candidates are tried before falling back to a spiral. */
const SPAWN_CANDIDATES = 240;
/** A spawn spot this flat or flatter is accepted immediately (height delta / unit). */
const SPAWN_TARGET_SLOPE = 0.16;
/** How far from the centre hills may sit, as a fraction of the radius. */
const HILL_SPREAD = 0.88;

/**
 * Smooth Hermite interpolation between two edges.
 *
 * @param {number} edge0 Lower edge.
 * @param {number} edge1 Upper edge.
 * @param {number} x Value to map.
 * @returns {number} A smoothly interpolated value in [0, 1].
 */
function smoothstep( edge0, edge1, x ) {

	const t = Math.min( 1, Math.max( 0, ( x - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3 - 2 * t );

}

/**
 * Creates the seeded hills that give the island its shape.
 *
 * Hills are placed with a square root on the radius, which spreads them evenly over the
 * *area* instead of clumping them around the centre.
 *
 * @param {object} rng Seeded PRNG.
 * @param {object} config Height field configuration.
 * @returns {Array<{x: number, z: number, radius: number, radiusSquared: number, height: number}>} Hills.
 */
function createHills( rng, config ) {

	const hills = [];
	const radiusRange = config.hillRadiusMax - config.hillRadiusMin;
	const heightRange = config.hillHeightMax - config.hillHeightMin;

	for ( let i = 0; i < config.hillCount; i ++ ) {

		const angle = rng.random() * Math.PI * 2;
		const distance = Math.sqrt( rng.random() ) * config.radius * HILL_SPREAD;
		const radius = config.hillRadiusMin + rng.random() * radiusRange;

		// Cap each height against its footprint so no hill becomes a spike the car can never
		// climb: for a cosine profile the steepest grade is height * PI / (2 * radius).
		const sampled = config.hillHeightMin + rng.random() * heightRange;
		const height = Math.min( sampled, config.hillMaxGrade * radius );

		hills.push( {
			x: Math.cos( angle ) * distance,
			z: Math.sin( angle ) * distance,
			radius,
			radiusSquared: radius * radius,
			height,
		} );

	}

	return hills;

}

/**
 * Builds a deterministic island height field.
 *
 * @param {object} [options] Overrides for the values found in {@link WORLD}.
 * @param {number} [options.seed] Seed of the island; determines the whole terrain.
 * @param {number} [options.radius] Falloff scale of the island.
 * @param {number} [options.seaLevel] World height of the ocean surface.
 * @param {number} [options.shoreClearance] Margin above sea level required for land.
 * @returns {object} The height field API (see the end of this module).
 */
export function createHeightField( options = {} ) {

	const config = {
		seed: WORLD.defaultSeed,
		radius: WORLD.islandRadius,
		baseHeight: WORLD.baseHeight,
		hillCount: WORLD.hillCount,
		hillRadiusMin: WORLD.hillRadiusMin,
		hillRadiusMax: WORLD.hillRadiusMax,
		hillHeightMin: WORLD.hillHeightMin,
		hillHeightMax: WORLD.hillHeightMax,
		hillMaxGrade: WORLD.hillMaxGrade,
		hillHeightCap: WORLD.hillHeightCap,
		detailAmplitude: WORLD.detailAmplitude,
		detailScale: WORLD.detailScale,
		detailOctaves: WORLD.detailOctaves,
		edgeDrop: WORLD.edgeDrop,
		falloffInner: WORLD.falloffInner,
		falloffOuter: WORLD.falloffOuter,
		seaLevel: WORLD.seaLevel,
		shoreClearance: WORLD.shoreClearance,
		spawnMinHeight: WORLD.spawnMinHeight,
		size: WORLD.size,
		waterLevel: WORLD.waterLevel,
		...options,
	};

	// Seeded PRNGs -> reproducible islands. The detail noise and the hills get separate
	// streams, so changing one cannot shift the other.
	const noise = new SimplexNoise( mulberry32( config.seed ^ 0x2545F491 ) );
	const hills = createHills( mulberry32( config.seed ^ 0x9E3779B9 ), config );

	/**
	 * Fractal Brownian motion over the simplex noise, centred on zero.
	 *
	 * @param {number} x Sample x.
	 * @param {number} z Sample z.
	 * @returns {number} Noise value in [-1, 1].
	 */
	function fbm( x, z ) {

		let sum = 0;
		let amplitude = 1;
		let frequency = 1;
		let normalization = 0;

		for ( let octave = 0; octave < config.detailOctaves; octave ++ ) {

			sum += amplitude * noise.noise( x * frequency, z * frequency );
			normalization += amplitude;
			amplitude *= 0.5;
			frequency *= 2;

		}

		return sum / normalization;

	}

	/**
	 * Summed height of every hill covering a position.
	 *
	 * Each hill is a smooth cosine bump that reaches exactly zero, with zero slope, at its
	 * radius, so hills blend into each other and into the plateau without seams. The total
	 * saturates softly, which stops overlapping hills from stacking into a spike.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @returns {number} Hill height contribution.
	 */
	function hillHeight( x, z ) {

		let sum = 0;

		for ( let i = 0; i < hills.length; i ++ ) {

			const hill = hills[ i ];
			const dx = x - hill.x;
			if ( dx < - hill.radius || dx > hill.radius ) continue;

			const dz = z - hill.z;
			if ( dz < - hill.radius || dz > hill.radius ) continue;

			const distanceSquared = dx * dx + dz * dz;
			if ( distanceSquared >= hill.radiusSquared ) continue;

			const t = Math.sqrt( distanceSquared ) / hill.radius;
			sum += hill.height * 0.5 * ( 1 + Math.cos( Math.PI * t ) );

		}

		// Smooth saturation: close to the identity for small sums, never above the cap.
		const cap = config.hillHeightCap;
		return cap * ( 1 - Math.exp( - sum / cap ) );

	}

	/**
	 * Terrain height at a world position.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @returns {number} Height in world units (sea level is 0).
	 */
	function heightAt( x, z ) {

		const r = Math.hypot( x, z ) / config.radius;
		const falloff = 1 - smoothstep( config.falloffInner, config.falloffOuter, r );

		const land = config.baseHeight +
			hillHeight( x, z ) +
			fbm( x * config.detailScale, z * config.detailScale ) * config.detailAmplitude;

		return land * falloff - ( 1 - falloff ) * config.edgeDrop;

	}

	/**
	 * Terrain slope as the largest height delta per world unit (a grade, not an angle).
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @returns {number} Non negative grade.
	 */
	function slopeAt( x, z ) {

		const dx = Math.abs( heightAt( x + NORMAL_EPSILON, z ) - heightAt( x - NORMAL_EPSILON, z ) );
		const dz = Math.abs( heightAt( x, z + NORMAL_EPSILON ) - heightAt( x, z - NORMAL_EPSILON ) );

		return Math.max( dx, dz ) / ( 2 * NORMAL_EPSILON );

	}

	/**
	 * Surface normal at a world position, from an analytic finite difference of the height
	 * field. Cheaper and smoother than raycasting the terrain mesh.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @param {{x:number,y:number,z:number}} [out] Object to write into (a `THREE.Vector3` works).
	 * @returns {{x:number,y:number,z:number}} The normalized normal.
	 */
	function normalAt( x, z, out = { x: 0, y: 1, z: 0 } ) {

		const inv = 1 / ( 2 * NORMAL_EPSILON );
		const dx = ( heightAt( x + NORMAL_EPSILON, z ) - heightAt( x - NORMAL_EPSILON, z ) ) * inv;
		const dz = ( heightAt( x, z + NORMAL_EPSILON ) - heightAt( x, z - NORMAL_EPSILON ) ) * inv;

		const nx = - dx;
		const ny = 1;
		const nz = - dz;
		const length = Math.hypot( nx, ny, nz );

		out.x = nx / length;
		out.y = ny / length;
		out.z = nz / length;

		return out;

	}

	/**
	 * Whether a position is dry land the car is allowed to drive on.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @param {number} [clearance] Required height above sea level.
	 * @returns {boolean} True when the position is land.
	 */
	function isLand( x, z, clearance = config.shoreClearance ) {

		return heightAt( x, z ) > config.seaLevel + clearance;

	}

	/**
	 * How deep the sea is at a position.
	 *
	 * Positive inside the water, zero or negative on dry land.
	 *
	 * @param {number} x World x.
	 * @param {number} z World z.
	 * @returns {number} Depth in world units below the water surface.
	 */
	function waterDepthAt( x, z ) {

		return config.waterLevel - heightAt( x, z );

	}

	/**
	 * Finds a flat, dry spot to place the car at.
	 *
	 * Uses its own PRNG stream derived from the seed, so the result never depends on how
	 * many random numbers other systems (e.g. the props) consumed.
	 *
	 * @returns {{x: number, z: number, height: number, slope: number}} The spawn position.
	 */
	function findSpawnPoint() {

		const rng = mulberry32( config.seed ^ 0x5F1D93 );

		let best = null;

		for ( let i = 0; i < SPAWN_CANDIDATES; i ++ ) {

			const angle = rng.random() * Math.PI * 2;
			const distance = ( 0.05 + rng.random() * 0.4 ) * config.radius;
			const x = Math.cos( angle ) * distance;
			const z = Math.sin( angle ) * distance;
			const height = heightAt( x, z );

			if ( height <= config.seaLevel + config.shoreClearance ) continue;

			const slope = slopeAt( x, z );
			const candidate = { x, z, height, slope };

			// Accept immediately when the spot is both flat and comfortably above the
			// waterline, so the car starts on grass instead of on the beach.
			if ( slope <= SPAWN_TARGET_SLOPE && height >= config.seaLevel + config.spawnMinHeight ) return candidate;
			if ( best === null || slope < best.slope ) best = candidate;

		}

		if ( best !== null ) return best;

		// Fallback: walk outwards from the centre in fine steps until dry land turns up.
		for ( let distance = 0; distance < config.radius; distance += 6 ) {

			for ( let step = 0; step < 12; step ++ ) {

				const angle = ( step / 12 ) * Math.PI * 2;
				const x = Math.cos( angle ) * distance;
				const z = Math.sin( angle ) * distance;

				if ( isLand( x, z ) ) return { x, z, height: heightAt( x, z ), slope: slopeAt( x, z ) };

			}

		}

		return { x: 0, z: 0, height: heightAt( 0, 0 ), slope: slopeAt( 0, 0 ) };

	}

	return {
		seed: config.seed,
		radius: config.radius,
		size: config.size,
		seaLevel: config.seaLevel,
		waterLevel: config.waterLevel,
		/** The seeded hills, exposed so their spread can be inspected and tested. */
		hills,
		heightAt,
		normalAt,
		slopeAt,
		isLand,
		waterDepthAt,
		findSpawnPoint,
	};

}
