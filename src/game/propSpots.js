/**
 * Where the scenery goes: the placement rules for trees and rocks.
 *
 * This is deliberately separate from {@link ../world/props.js}, which only *draws* the
 * scenery. Two things need the tree list: the renderer, and — in multiplayer — the server,
 * which keeps the authoritative collision world with no meshes at all. Sharing the generator
 * is what makes those two agree: a tree the server refuses to break is a tree the client still
 * sees standing, and vice versa.
 *
 * Pure (no DOM, no three.js), so it runs headless under Vitest and on the server in Node.
 */

import { mulberry32 } from '../world/rng.js';
import { PROPS } from '../config.js';

/** How many random picks are attempted per prop before giving up on it. */
const ATTEMPTS_PER_PROP = 40;
/** Minimum distance between clump centres. */
const CLUMP_SPACING = 60;
/** Seed offset of the props' own PRNG stream, so props never depend on other consumers. */
const PROP_SEED = 0x1B2D3F;

/**
 * Whether terrain at a position can hold a prop.
 *
 * @param {object} heightField Terrain.
 * @param {object} config Placement rules.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {boolean} True when the spot is suitable.
 */
export function isPropSuitable( heightField, config, x, z ) {

	if ( heightField.isLand( x, z ) === false ) return false;

	const height = heightField.heightAt( x, z );
	if ( height < config.minHeight || height > config.maxHeight ) return false;

	return heightField.slopeAt( x, z ) <= config.maxSlope;

}

/**
 * Scatters trees in clumps across the island.
 *
 * @param {object} heightField Terrain.
 * @param {object} rng Seeded PRNG.
 * @param {object} config Placement rules.
 * @returns {Array<{x: number, z: number, height: number, scale: number, rotation: number}>} Tree spots.
 */
function findTreeSpots( heightField, rng, config ) {

	const spots = [];
	const radiusRange = config.maxRadius - config.minRadius;
	const clumps = [];

	for ( let clump = 0; clump < config.clusters && spots.length < config.trees; clump ++ ) {

		const angle = rng.random() * Math.PI * 2;
		const distance = ( config.minRadius + rng.random() * radiusRange ) * heightField.radius;
		const centreX = Math.cos( angle ) * distance;
		const centreZ = Math.sin( angle ) * distance;

		let tooClose = false;

		for ( let i = 0; i < clumps.length; i ++ ) {

			if ( Math.hypot( clumps[ i ].x - centreX, clumps[ i ].z - centreZ ) < CLUMP_SPACING ) {

				tooClose = true;
				break;

			}

		}

		if ( tooClose || isPropSuitable( heightField, config, centreX, centreZ ) === false ) continue;

		clumps.push( { x: centreX, z: centreZ } );

		const count = config.clusterSizeMin +
			Math.floor( rng.random() * ( config.clusterSizeMax - config.clusterSizeMin + 1 ) );
		const spread = config.clusterRadiusMin +
			rng.random() * ( config.clusterRadiusMax - config.clusterRadiusMin );

		for ( let i = 0; i < count && spots.length < config.trees; i ++ ) {

			const treeAngle = rng.random() * Math.PI * 2;
			const treeDistance = Math.sqrt( rng.random() ) * spread;
			const x = centreX + Math.cos( treeAngle ) * treeDistance;
			const z = centreZ + Math.sin( treeAngle ) * treeDistance;

			if ( isPropSuitable( heightField, config, x, z ) === false ) continue;

			spots.push( {
				x,
				z,
				height: heightField.heightAt( x, z ),
				scale: 0.85 + rng.random() * 0.5,
				rotation: rng.random() * Math.PI * 2,
			} );

		}

	}

	// Top up with lone trees if the clumps came up short (small or bumpy islands).
	const maxAttempts = config.trees * ATTEMPTS_PER_PROP;

	for ( let attempt = 0; attempt < maxAttempts && spots.length < config.trees; attempt ++ ) {

		const angle = rng.random() * Math.PI * 2;
		const distance = ( config.minRadius + rng.random() * radiusRange ) * heightField.radius;
		const x = Math.cos( angle ) * distance;
		const z = Math.sin( angle ) * distance;

		if ( isPropSuitable( heightField, config, x, z ) === false ) continue;

		spots.push( {
			x,
			z,
			height: heightField.heightAt( x, z ),
			scale: 0.85 + rng.random() * 0.5,
			rotation: rng.random() * Math.PI * 2,
		} );

	}

	return spots;

}

/**
 * Scatters rocks across the island.
 *
 * @param {object} heightField Terrain.
 * @param {object} rng Seeded PRNG.
 * @param {object} config Placement rules.
 * @returns {Array<{x: number, z: number, height: number, scale: number, rotation: number}>} Rock spots.
 */
function findRockSpots( heightField, rng, config ) {

	const spots = [];
	const maxAttempts = config.rocks * ATTEMPTS_PER_PROP;
	const radiusRange = config.maxRadius - config.minRadius;

	// Rocks are happy on almost any dry terrain, including steep faces.
	const rockRules = { ...config, maxSlope: 2 };

	for ( let attempt = 0; attempt < maxAttempts && spots.length < config.rocks; attempt ++ ) {

		const angle = rng.random() * Math.PI * 2;
		const distance = ( config.minRadius + rng.random() * radiusRange ) * heightField.radius;
		const x = Math.cos( angle ) * distance;
		const z = Math.sin( angle ) * distance;

		if ( isPropSuitable( heightField, rockRules, x, z ) === false ) continue;

		spots.push( {
			x,
			z,
			height: heightField.heightAt( x, z ),
			scale: 0.8 + rng.random() * 0.8,
			rotation: rng.random() * Math.PI * 2,
		} );

	}

	return spots;

}

/**
 * Builds the spawn-clearance test: the car's spawn area is kept free of scenery, so a new
 * island can never start with the car wedged inside a clump.
 *
 * @param {{x: number, z: number}} spawn Spawn point.
 * @param {number} clearance Radius to keep clear, in world units.
 * @returns {(spot: {x: number, z: number}) => boolean} Predicate that keeps a spot.
 */
export function keepClearOfSpawn( spawn, clearance ) {

	const clearanceSquared = clearance * clearance;

	return function clearOfSpawn( spot ) {

		const dx = spot.x - spawn.x;
		const dz = spot.z - spawn.z;

		return dx * dx + dz * dz > clearanceSquared;

	};

}

/**
 * Places every prop on the island.
 *
 * The PRNG stream is created here rather than by the caller, and consumed in a fixed order
 * (trees, then rocks), because that order is part of what makes an island reproducible. The
 * server runs the same function to get the same trees.
 *
 * @param {object} heightField The terrain to populate.
 * @param {object} [overrides] Overrides for {@link PROPS}.
 * @returns {{ config: object, spawn: object, treeSpots: Array<object>, rockSpots: Array<object> }} Placement.
 */
export function createPropSpots( heightField, overrides = {} ) {

	const config = { ...PROPS, ...overrides };
	const rng = mulberry32( heightField.seed ^ PROP_SEED );
	const spawn = heightField.findSpawnPoint();
	const clearOfSpawn = keepClearOfSpawn( spawn, config.spawnClearance );

	return {
		config,
		spawn,
		treeSpots: findTreeSpots( heightField, rng, config ).filter( clearOfSpawn ),
		rockSpots: findRockSpots( heightField, rng, config ).filter( clearOfSpawn ),
	};

}

/**
 * Turns tree spots into the tree registry the physics queries.
 *
 * The index is the position in `spots`, which is also the `InstancedMesh` instance index the
 * renderer uses — that is what lets a broken tree be replicated as a single integer.
 *
 * @param {Array<object>} spots Tree spots, in order.
 * @param {object} [config] Placement rules, for the trunk collision radius.
 * @returns {Array<{x: number, z: number, y: number, index: number, radius: number,
 *   crownRadius: number, alive: boolean}>} Trees.
 */
export function toTreeRegistry( spots, config = PROPS ) {

	const trunkRadius = config.treeRadius ?? PROPS.treeRadius;

	return spots.map( ( spot, index ) => ( {
		x: spot.x,
		z: spot.z,
		y: spot.height,
		index,
		radius: trunkRadius * spot.scale,
		crownRadius: 1.5 * spot.scale,
		alive: true,
	} ) );

}