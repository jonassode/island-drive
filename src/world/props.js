/**
 * Scattered scenery: trees and rocks.
 *
 * Trees are drawn with two `InstancedMesh`es (a trunk and a crown), so a few thousand of
 * them cost two draw calls. This module also owns the *tree registry*: the trunk positions
 * together with the instance index needed to remove one. That is what makes smashing a
 * tree possible — `breakTree()` shrinks its instances to nothing and hands back the
 * information the caller needs to spawn debris.
 *
 * Where the scenery *goes* is {@link ../game/propSpots.js}, because the multiplayer server
 * needs the same tree list without any meshes; this module only turns those spots into
 * geometry.
 *
 * Trees grow in clumps rather than uniformly, so the island has open meadows to drive
 * across and thickets that are worth avoiding.
 */

import {
	ConeGeometry, CylinderGeometry, DynamicDrawUsage, Group, IcosahedronGeometry,
	InstancedMesh, Matrix4, MeshStandardMaterial, Object3D,
} from 'three';
import { createPropSpots, toTreeRegistry } from '../game/propSpots.js';
import { COLORS } from '../config.js';

/**
 * Creates the island scenery.
 *
 * @param {object} heightField The terrain to populate.
 * @param {object} [overrides] Overrides for {@link PROPS}.
 * @returns {{ group: Group, trees: Array<object>, treeCount: number, breakTree: Function,
 *   dispose: () => void }} The scenery.
 */
export function createProps( heightField, overrides = {} ) {

	const { config, treeSpots, rockSpots } = createPropSpots( heightField, overrides );

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
	// The tree registry is built from the same spots the meshes are, so index `i` of the
	// registry is instance `i` of both `InstancedMesh`es: that is what makes a broken tree
	// replicable as a single integer.
	const trees = toTreeRegistry( treeSpots, config );
	let meshes = null;

	if ( treeSpots.length > 0 ) {

		const trunkGeometry = new CylinderGeometry( 0.16, 0.26, 1, 6 );
		trunkGeometry.translate( 0, 0.5, 0 );

		const crownGeometry = new ConeGeometry( 1, 1, 7 );
		crownGeometry.translate( 0, 0.5, 0 );

		const trunkMaterial = new MeshStandardMaterial( { color: COLORS.trunk, roughness: 0.9 } );
		const crownMaterial = new MeshStandardMaterial( { color: COLORS.foliage, roughness: 0.85 } );

		const trunks = new InstancedMesh( trunkGeometry, trunkMaterial, treeSpots.length );
		const crowns = new InstancedMesh( crownGeometry, crownMaterial, treeSpots.length );

		treeSpots.forEach( ( spot, index ) => {

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