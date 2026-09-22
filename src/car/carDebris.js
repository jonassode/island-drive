/**
 * Debris bursts: what is left behind when a tree is smashed.
 *
 * A smashed tree spawns a short lived clump of green shards that fly outwards, fall under
 * gravity and fade away. Everything is procedural (a few tiny meshes in a shared pool), so
 * there is no asset to load and no allocation to speak of while driving.
 */

import { ConeGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { COLORS } from '../config.js';

/** Shards spawned per broken tree. */
const SHARDS_PER_TREE = 7;
/** How long a burst lasts, in seconds. */
const LIFETIME = 1.3;
/** Gravity applied to the shards, in units / second squared. */
const GRAVITY = 18;
/** How much of the car's speed the shards inherit. */
const INHERIT_SPEED = 0.35;

/**
 * Creates the debris system.
 *
 * @returns {{ group: Group, burst: Function, update: Function, dispose: () => void }} Debris.
 */
export function createDebris() {

	const group = new Group();
	group.name = 'debris';

	const geometry = new ConeGeometry( 0.4, 1.2, 5 );
	const material = new MeshStandardMaterial( {
		color: COLORS.foliage, roughness: 0.85, flatShading: true,
	} );

	/** Pool of shards. Every entry is reused forever, so driving never allocates. */
	const shards = [];
	/** Shards that are currently in flight. */
	const active = [];

	const scratch = new Object3D();
	const direction = new Vector3();

	for ( let i = 0; i < SHARDS_PER_TREE * 4; i ++ ) {

		const mesh = new Mesh( geometry, material );
		mesh.visible = false;
		mesh.castShadow = true;
		group.add( mesh );

		shards.push( {
			mesh,
			velocity: new Vector3(),
			spin: new Vector3(),
			life: 0,
		} );

	}

	/**
	 * Spawns a debris burst where a tree used to stand.
	 *
	 * @param {{x: number, y: number, z: number, radius: number}} at Debris info from
	 *   `createProps().breakTree()`.
	 * @param {number} [carSpeedX] Car velocity x, so the shards inherit some of it.
	 * @param {number} [carSpeedZ] Car velocity z.
	 * @returns {void}
	 */
	function burst( at, carSpeedX = 0, carSpeedZ = 0 ) {

		let spawned = 0;

		for ( let i = 0; i < shards.length && spawned < SHARDS_PER_TREE; i ++ ) {

			const shard = shards[ i ];
			if ( shard.life > 0 ) continue;

			const angle = ( spawned / SHARDS_PER_TREE ) * Math.PI * 2 + Math.random() * 0.6;
			const speed = 4 + Math.random() * 6;

			direction.set( Math.cos( angle ), 0.9 + Math.random() * 0.8, Math.sin( angle ) ).normalize();

			shard.mesh.position.set(
				at.x + Math.cos( angle ) * 0.5,
				at.y + 1 + Math.random() * 2,
				at.z + Math.sin( angle ) * 0.5,
			);
			shard.mesh.rotation.set( Math.random() * 3, Math.random() * 3, Math.random() * 3 );
			shard.mesh.scale.setScalar( ( at.radius ?? 1.5 ) * ( 0.5 + Math.random() * 0.5 ) );
			shard.mesh.visible = true;

			shard.velocity.set(
				direction.x * speed + carSpeedX * INHERIT_SPEED,
				direction.y * speed,
				direction.z * speed + carSpeedZ * INHERIT_SPEED,
			);
			shard.spin.set( Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4 );
			shard.life = LIFETIME * ( 0.7 + Math.random() * 0.5 );

			active.push( shard );
			spawned ++;

		}

	}

	/**
	 * Advances the debris.
	 *
	 * @param {number} dt Time step in seconds.
	 * @returns {void}
	 */
	function update( dt ) {

		for ( let i = active.length - 1; i >= 0; i -- ) {

			const shard = active[ i ];
			shard.life -= dt;

			if ( shard.life <= 0 ) {

				shard.mesh.visible = false;
				active.splice( i, 1 );
				continue;

			}

			shard.velocity.y -= GRAVITY * dt;

			scratch.position.copy( shard.mesh.position ).addScaledVector( shard.velocity, dt );
			shard.mesh.position.copy( scratch.position );

			shard.mesh.rotation.x += shard.spin.x * dt;
			shard.mesh.rotation.y += shard.spin.y * dt;
			shard.mesh.rotation.z += shard.spin.z * dt;

			// Shrink away over the last part of the life, which reads as dissolving foliage.
			const fade = Math.min( 1, shard.life / ( LIFETIME * 0.6 ) );
			shard.mesh.scale.setScalar( Math.max( 0.01, shard.mesh.scale.x * ( 0.9 + fade * 0.1 ) ) );

		}

	}

	return {
		group,
		burst,
		update,
		/** How many shards are in the air, for tests and debugging. */
		get activeCount() {

			return active.length;

		},
		dispose() {

			geometry.dispose();
			material.dispose();

		},
	};

}