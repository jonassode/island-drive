/**
 * Scattered scenery: trees and rocks.
 *
 * Trees are drawn with two `InstancedMesh`es (a trunk and a crown), so a few thousand of
 * them cost two draw calls. This module also owns the *tree registry*: the trunk positions
 * together with the instance index needed to remove one. That is what makes smashing a
 * tree possible — `breakTree()` shrinks its instances to nothing and hands back the
 * information the caller needs to spawn debris.
 *
 * Trees grow in clumps rather than uniformly, so the island has open meadows to drive
 * across and thickets that are worth avoiding.
 */

import {
	ConeGeometry, CylinderGeometry, DynamicDrawUsage, Group, IcosahedronGeometry,
	InstancedMesh, Matrix4, MeshStandardMaterial, Object3D,
} from 'three';
import { mulberry32 } from './rng.js';
import { COLORS, PROPS } from '../config.js';

/** How many random picks are attempted per prop before giving up on it. */
const ATTEMPTS_PER_PROP = 40;
/** Minimum distance between clump centres. */
const CLUMP_SPACING = 60;

/**
 * Whether terrain at a position can hold a prop.
 *
 * @param {object} heightField Terrain.
 * @param {object} config Placement rules.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {boolean} True when the spot is suitable.
 */
function isSuitable( heightField, config, x, z ) {

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

		if ( tooClose || isSuitable( heightField, config, centreX, centreZ ) === false ) continue;

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

			if ( isSuitable( heightField, config, x, z ) === false ) continue;

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

		if ( isSuitable( heightField, config, x, z ) === false ) continue;

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

		if ( isSuitable( heightField, rockRules, x, z ) === false ) continue;

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
 * Creates the island scenery.
 *
 * @param {object} heightField The terrain to populate.
 * @param {object} [overrides] Overrides for {@link PROPS}.
 * @returns {{ group: Group, trees: Array<object>, treeCount: number, breakTree: Function,
 *   dispose: () => void }} The scenery.
 */
export function createProps( heightField, overrides = {} ) {

	const config = { ...PROPS, ...overrides };
	const rng = mulberry32( heightField.seed ^ 0x1B2D3F );

	const group = new Group();
	group.name = 'props';

	const disposables = [];
	const dummy = new Object3D();
	const zeroMatrix = new Matrix4().makeScale( 0, 0, 0 );

	/**
	 * Registers resources for disposal.
	 *
	 * @param {...object} items Geometries / materials.
	 * @returns {void}
	 */
	function track( ...items ) {

		disposables.push( ...items );

	}

	// --- trees ----------------------------------------------------------------------
	// The car's spawn area is kept clear: a clump of trees around the spawn would leave a
	// fresh island unplayable, with the car wedged before it can pick up speed.
	const spawn = heightField.findSpawnPoint();
	const clearanceSquared = config.spawnClearance * config.spawnClearance;

	function clearOfSpawn( spot ) {

		const dx = spot.x - spawn.x;
		const dz = spot.z - spawn.z;

		return dx * dx + dz * dz > clearanceSquared;

	}

	const spots = findTreeSpots( heightField, rng, config ).filter( clearOfSpawn );
	const trees = [];
	let meshes = null;

	if ( spots.length > 0 ) {

		const trunkGeometry = new CylinderGeometry( 0.16, 0.26, 1, 6 );
		trunkGeometry.translate( 0, 0.5, 0 );

		const crownGeometry = new ConeGeometry( 1, 1, 7 );
		crownGeometry.translate( 0, 0.5, 0 );

		const trunkMaterial = new MeshStandardMaterial( { color: COLORS.trunk, roughness: 0.9 } );
		const crownMaterial = new MeshStandardMaterial( { color: COLORS.foliage, roughness: 0.85 } );

		const trunks = new InstancedMesh( trunkGeometry, trunkMaterial, spots.length );
		const crowns = new InstancedMesh( crownGeometry, crownMaterial, spots.length );

		spots.forEach( ( spot, index ) => {

			const trunkHeight = 1.7 * spot.scale;
			const crownHeight = 3.6 * spot.scale;
			const crownRadius = 1.5 * spot.scale;

			dummy.position.set( spot.x, spot.height - 0.15, spot.z );
			dummy.rotation.set( 0, spot.rotation, 0 );
			dummy.scale.set( spot.scale, trunkHeight, spot.scale );
			dummy.updateMatrix();
			trunks.setMatrixAt( index, dummy.matrix );

			dummy.position.set( spot.x, spot.height - 0.15 + trunkHeight * 0.5, spot.z );
			dummy.scale.set( crownRadius, crownHeight, crownRadius );
			dummy.updateMatrix();
			crowns.setMatrixAt( index, dummy.matrix );

			trees.push( {
				x: spot.x,
				z: spot.z,
				y: spot.height,
				index,
				radius: PROPS.treeRadius * spot.scale,
				crownRadius,
				alive: true,
			} );

		} );

		for ( const mesh of [ trunks, crowns ] ) {

			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.instanceMatrix.setUsage( DynamicDrawUsage ); // trees vanish at runtime
			mesh.instanceMatrix.needsUpdate = true;
			group.add( mesh );

		}

		track( trunkGeometry, crownGeometry, trunkMaterial, crownMaterial );
		meshes = { trunks, crowns };

	}
	// --- rocks ----------------------------------------------------------------------
	const rockSpots = findRockSpots( heightField, rng, config ).filter( clearOfSpawn );

	if ( rockSpots.length > 0 ) {

		const rockGeometry = new IcosahedronGeometry( 1, 0 );
		const rockMaterial = new MeshStandardMaterial( {
			color: COLORS.rockProp, roughness: 0.95, flatShading: true,
		} );

		const rocks = new InstancedMesh( rockGeometry, rockMaterial, rockSpots.length );

		rockSpots.forEach( ( rock, index ) => {

			const size = 0.8 * rock.scale;

			dummy.position.set( rock.x, rock.height + size * 0.2, rock.z );
			dummy.rotation.set( rock.rotation * 0.4, rock.rotation, rock.rotation * 0.2 );
			dummy.scale.set( size, size * 0.72, size * 1.15 );
			dummy.updateMatrix();
			rocks.setMatrixAt( index, dummy.matrix );

		} );

		rocks.castShadow = true;
		rocks.receiveShadow = true;
		rocks.instanceMatrix.needsUpdate = true;
		group.add( rocks );

		track( rockGeometry, rockMaterial );

	}

	/**
	 * Removes a tree from the world.
	 *
	 * Both of its instances are scaled to nothing rather than the mesh being rebuilt, which
	 * keeps the removal O(1) and needs no reallocation.
	 *
	 * @param {object} tree A tree from `trees`.
	 * @returns {{x: number, z: number, y: number, radius: number}|null} Debris info, or null
	 *   when the tree was already gone.
	 */
	function breakTree( tree ) {

		if ( tree.alive === false ) return null;

		tree.alive = false;

		if ( meshes !== null ) {

			meshes.trunks.setMatrixAt( tree.index, zeroMatrix );
			meshes.crowns.setMatrixAt( tree.index, zeroMatrix );
			meshes.trunks.instanceMatrix.needsUpdate = true;
			meshes.crowns.instanceMatrix.needsUpdate = true;

		}

		return { x: tree.x, z: tree.z, y: tree.y, radius: tree.crownRadius };

	}

	return {
		group,
		/** Trunk positions with the flags and indices needed to break them. */
		trees,
		treeCount: trees.length,
		breakTree,
		dispose() {

			for ( const item of disposables ) item.dispose();

		},
	};

}