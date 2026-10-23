/**
 * The other players' cars: one mesh per player, drawn from the snapshot stream.
 *
 * Snapshots arrive at `MULTIPLAYER.snapshotRate` while frames are drawn at whatever the screen
 * does, so a car cannot simply be placed at its newest snapshot: that would stutter on every
 * arrival. Instead every arrival is buffered and the car is drawn a fixed `interpDelayMs`
 * behind the newest one, interpolating between the two snapshots that straddle that moment.
 * That delay is what absorbs a late packet: as long as arrivals are jittery rather than
 * *slower* than the delay, there is always a pair of snapshots to draw between.
 *
 * Names and colours come from the room's roster; the meshes are the same `buildCar()` the local
 * car uses, only painted differently.
 */

import { CanvasTexture, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';
import { buildCar } from '../car/carModel.js';
import { createCarTransform } from '../car/carTransform.js';
import { fitCarToGround } from '../car/carPose.js';
import { CAR, MULTIPLAYER } from '../config.js';
import { FLAG } from './protocol.js';

/** How many snapshots are kept per car. Two are needed; the rest cover a jittery link. */
const BUFFER_SIZE = 12;
/** Height above the car's origin that the name tag floats, in world units. */
const LABEL_HEIGHT = 2.3;
/** World height of the tag itself. About a quarter of the car's length: readable from the
 * chase camera, without the tag being the biggest thing on screen. */
const LABEL_WORLD_HEIGHT = 0.9;
/** Font size of the tag on its canvas. */
const LABEL_FONT_SIZE = 28;

/**
 * Draws a player's name onto a billboard.
 *
 * @param {string} text Name to draw.
 * @param {string} color CSS colour of the text, matching the car's paint.
 * @returns {Sprite} The label, to be parented to the car and disposed with it.
 */
function createLabel( text, color ) {

	const canvas = document.createElement( 'canvas' );
	const context = canvas.getContext( '2d' );
	const font = `600 ${LABEL_FONT_SIZE}px ui-sans-serif, system-ui, sans-serif`;

	context.font = font;

	const width = Math.ceil( context.measureText( text ).width ) + 28;
	const height = LABEL_FONT_SIZE + 18;

	// Resizing a canvas resets its 2D context, so the font is set again afterwards.
	canvas.width = width;
	canvas.height = height;

	context.font = font;
	context.textAlign = 'center';
	context.textBaseline = 'middle';

	context.fillStyle = 'rgba(8, 16, 26, 0.7)';
	context.beginPath();
	context.roundRect( 0, 0, width, height, height / 2 );
	context.fill();

	context.fillStyle = color;
	context.fillText( text, width / 2, height / 2 + 1 );

	const texture = new CanvasTexture( canvas );
	texture.colorSpace = SRGBColorSpace;

	const material = new SpriteMaterial( { map: texture, transparent: true, depthWrite: false } );
	const sprite = new Sprite( material );

	// The canvas is a fixed number of pixels, so the tag is scaled into world units: small
	// enough not to dwarf the car, large enough to read from the chase camera.
	const unit = LABEL_WORLD_HEIGHT / height;
	sprite.scale.set( width * unit, LABEL_WORLD_HEIGHT, 1 );
	sprite.center.set( 0.5, 0 );
	sprite.name = 'name-tag';
	sprite.userData.name = text;

	return sprite;

}

/**
 * Disposes a label entirely, canvas texture included.
 *
 * @param {Sprite} label Label to free.
 * @returns {void}
 */
function disposeLabel( label ) {

	label.material.map?.dispose();
	label.material.dispose();

}

/**
 * Turns a colour number into the CSS string the label canvas wants.
 *
 * @param {number} color Hex colour.
 * @returns {string} `#rrggbb`.
 */
function cssColor( color ) {

	return `#${( color >>> 0 ).toString( 16 ).padStart( 6, '0' )}`;

}

/**
 * Lightens a paint colour until it reads against the tag's dark background.
 *
 * The tag's text is the player's own colour, which is what makes a car identifiable at a
 * glance — but half the palette (blue, purple, the dark greens) is too close to the tag's
 * own dark panel to read. So the text is mixed towards white by as much as its luminance
 * needs, and no more: a yellow or a white car keeps its colour, a purple one is lightened.
 *
 * @param {number} color Hex colour.
 * @returns {string} A CSS `#rrggbb` string that will be legible on the tag.
 */
export function readableColor( color ) {

	const r = ( color >> 16 ) & 0xff;
	const g = ( color >> 8 ) & 0xff;
	const b = color & 0xff;

	// Rec. 709 luminance, 0 (black) to 1 (white).
	const luminance = ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) / 255;
	const lift = Math.max( 0, Math.min( 1, ( 0.72 - luminance ) / 0.72 ) );

	/**
	 * Mixes one channel towards white.
	 *
	 * @param {number} channel Channel value.
	 * @returns {number} Mixed value.
	 */
	const mix = ( channel ) => Math.round( channel + ( 255 - channel ) * lift );

	return cssColor( ( mix( r ) << 16 ) | ( mix( g ) << 8 ) | mix( b ) );

}

/**
 * Creates the remote car layer.
 *
 * @param {object} options Options.
 * @param {object} options.scene Scene to add the cars to.
 * @param {object} options.world Live accessors for the current island: `{ field, props }`, so
 *   a regenerated island is picked up without rebuilding this layer.
 * @param {object} options.debris Debris system, for the shards of a smashed tree.
 * @param {object} [options.config] Overrides for {@link MULTIPLAYER}.
 * @returns {object} The layer.
 */
export function createRemoteCars( options ) {

	const config = { ...MULTIPLAYER, ...options.config };
	const { scene, world, debris } = options;

	/** id -> remote car record. */
	const cars = new Map();
	let selfId = 0;

	/**
	 * Creates the mesh for one player.
	 *
	 * @param {object} player Roster entry.
	 * @returns {object} The remote car record.
	 */
	function createCar( player ) {

		const car = buildCar( { color: player.color } );
		car.group.name = `car-${player.id}`;
		scene.add( car.group );

		const label = createLabel( player.name, readableColor( player.color ) );
		label.position.set( 0, LABEL_HEIGHT, 0 );
		car.group.add( label );

		return {
			id: player.id,
			name: player.name,
			car,
			transform: createCarTransform( car ),
			label,
			/** Snapshots, oldest first: `{ t, entry }`, where `t` is a local timestamp. */
			buffer: [],
			/** Interpolated state the mesh is posed from. */
			state: {
				x: 0, y: 0, z: 0, heading: 0, speed: 0, steerAngle: 0, airborne: false, inWater: false,
			},
			/** Terrain fit for this car, reused every frame so nothing is allocated. */
			pose: {
				up: { x: 0, y: 1, z: 0 },
				travel: new Float32Array( car.wheelOffsets.length ),
				groundY: 0,
			},
		};

	}

	/**
	 * Removes a player's mesh and frees its GPU resources.
	 *
	 * @param {number} id Player id.
	 * @returns {void}
	 */
	function removeCar( id ) {

		const remote = cars.get( id );
		if ( remote === undefined ) return;

		scene.remove( remote.car.group );
		disposeLabel( remote.label );
		remote.car.dispose();
		cars.delete( id );

	}

	/**
	 * Replaces a player's name tag after a rename.
	 *
	 * @param {object} remote Remote car record.
	 * @param {object} player Roster entry.
	 * @returns {void}
	 */
	function refreshLabel( remote, player ) {

		if ( remote.name === player.name ) return;

		remote.car.group.remove( remote.label );
		disposeLabel( remote.label );

		const label = createLabel( player.name, readableColor( player.color ) );
		label.position.set( 0, LABEL_HEIGHT, 0 );
		remote.car.group.add( label );

		remote.label = label;
		remote.name = player.name;

	}

	return {
		/** How many other players are on screen, for the HUD and for tests. */
		get count() {

			return cars.size;

		},

		/**
		 * Reconciles the meshes with the room's roster.
		 *
		 * Called on every roster update: cars appear for new players and disappear for those who
		 * left. The local player is never one of them.
		 *
		 * @param {Array<object>} players Roster.
		 * @param {number} you Local player id.
		 * @param {number} [time] Local timestamp, for the placeholder parked on a spawn slot.
		 * @returns {void}
		 */
		sync( players, you, time = 0 ) {

			selfId = you;

			const wanted = new Set();

			for ( const player of players ) {

				if ( player.id === selfId ) continue;

				wanted.add( player.id );

				const existing = cars.get( player.id );

				if ( existing !== undefined ) {

					refreshLabel( existing, player );
					continue;

				}

				const remote = createCar( player );
				cars.set( player.id, remote );

				// Until a snapshot arrives there is nothing to interpolate, so the car waits on
				// its spawn slot, which reads as "not here yet" rather than as a car at the origin.
				if ( player.spawn !== undefined ) {

					remote.state.x = player.spawn.x;
					remote.state.z = player.spawn.z;
					remote.state.heading = player.spawn.heading ?? 0;
					remote.state.y = world.field.heightAt( player.spawn.x, player.spawn.z );
					remote.buffer.push( { t: time, entry: null } );

				}

			}

			for ( const id of [ ...cars.keys() ] ) {

				if ( wanted.has( id ) === false ) removeCar( id );

			}

		},

		/**
		 * Buffers a snapshot.
		 *
		 * @param {Array<object>} poses Pose entries, one per player.
		 * @param {number} time Local timestamp, in milliseconds.
		 * @returns {void}
		 */
		pushPoses( poses, time ) {

			for ( const entry of poses ) {

				if ( entry.id === selfId ) continue;

				const remote = cars.get( entry.id );
				if ( remote === undefined ) continue; // a join we have not been told about yet

				remote.buffer.push( { t: time, entry } );

				while ( remote.buffer.length > BUFFER_SIZE ) remote.buffer.shift();

			}

		},

		/**
		 * Interpolates every remote car and poses it.
		 *
		 * @param {number} dt Time step in seconds.
		 * @param {number} now Local timestamp, in milliseconds.
		 * @returns {void}
		 */
		update( dt, now ) {

			const renderTime = now - config.interpDelayMs;

			for ( const remote of cars.values() ) {

				const buffer = remote.buffer;
				if ( buffer.length === 0 ) continue;

				// The pair straddling the render time. When the stream has not caught up yet (or
				// has run dry) the newest sample stands in for both.
				let older = null;
				let newer = null;

				for ( let i = 0; i < buffer.length; i ++ ) {

					const sample = buffer[ i ];

					if ( sample.t <= renderTime ) {

						older = sample;

					} else {

						newer = sample;
						break;

					}

				}

				if ( older === null ) older = buffer[ 0 ];
				if ( newer === null ) newer = older;

				const state = remote.state;

				if ( older.entry === null || newer.entry === null ) {

					// Nothing authoritative yet: the parked spawn slot is already in `state`.
					remote.transform.apply( state, remote.pose, dt );
					continue;

				}

				const span = newer.t - older.t;
				const alpha = span > 1e-3
					? Math.min( 1, Math.max( 0, ( renderTime - older.t ) / span ) )
					: 1;

				state.x = older.entry.x + ( newer.entry.x - older.entry.x ) * alpha;
				state.y = older.entry.y + ( newer.entry.y - older.entry.y ) * alpha;
				state.z = older.entry.z + ( newer.entry.z - older.entry.z ) * alpha;
				state.speed = older.entry.speed + ( newer.entry.speed - older.entry.speed ) * alpha;
				state.steerAngle = older.entry.steer +
					( newer.entry.steer - older.entry.steer ) * alpha;
				state.heading = older.entry.heading +
					shortestAngle( newer.entry.heading - older.entry.heading ) * alpha;
				state.airborne = ( older.entry.flags & FLAG.airborne ) !== 0;
				state.inWater = ( older.entry.flags & FLAG.inWater ) !== 0;

				// The same terrain fit and suspension the local car gets, so a remote car sits on
				// a hill the way its own driver sees it sitting.
				fitCarToGround( world.field, state, remote.car.wheelOffsets, remote.pose, CAR );
				remote.transform.apply( state, remote.pose, dt );

			}

		},

		/**
		 * Plays the world events the server reported.
		 *
		 * A tree is only ever broken here, on the server's say-so: that keeps every client's
		 * wreckage identical, and makes the server's collision world the authority on which
		 * trees are still standing.
		 *
		 * @param {Array<object>} events Events from a snapshot.
		 * @returns {number} How many trees were removed.
		 */
		applyEvents( events ) {

			let broken = 0;

			for ( const event of events ) {

				if ( event.type !== 'treeBreak' ) continue;

				const tree = world.props.trees[ event.tree ];
				if ( tree === undefined || tree.alive === false ) continue;

				const debrisInfo = world.props.breakTree( tree );
				if ( debrisInfo !== null ) debris.burst( debrisInfo );
				broken ++;

			}

			return broken;

		},

		/**
		 * Forgets every buffered snapshot, after a new island.
		 *
		 * @returns {void}
		 */
		clear() {

			for ( const remote of cars.values() ) remote.buffer.length = 0;

		},

		/** Removes every remote car. */
		dispose() {

			for ( const id of [ ...cars.keys() ] ) removeCar( id );

		},

	};

}

/**
 * Wraps an angle difference into (-pi, pi], so a car crossing due south turns the short way.
 *
 * @param {number} angle Radians.
 * @returns {number} The shortest signed difference.
 */
function shortestAngle( angle ) {

	return Math.atan2( Math.sin( angle ), Math.cos( angle ) );

}