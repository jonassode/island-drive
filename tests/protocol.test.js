import { describe, expect, it } from 'vitest';
import {
	decode, error, full, input, join, leave, newIsland, pose, readFlags, readInputBatch,
	respawn, room as roomMessage, sanitizeName, snapshot, welcome, writePoseToState, FLAG,
} from '../src/multiplayer/protocol.js';
import { createCarState } from '../src/car/carPhysics.js';
import { createHeightField } from '../src/world/heightfield.js';
import { MULTIPLAYER } from '../src/config.js';

const field = createHeightField( { seed: 1 } );

describe( 'multiplayer protocol', () => {

	it( 'round-trips through JSON unchanged', () => {

		const messages = [
			welcome( { room: 'island', you: 2, seed: 7, players: [] } ),
			join( { id: 3, name: 'Bo', color: 0x2f6fd0, host: false, spawn: { x: 1, z: 2, heading: 0 } } ),
			leave( 3 ),
			roomMessage( { seed: 9, players: [] } ),
			snapshot( 12, [], [] ),
			full( 8 ),
			error( 'nope' ),
			respawn(),
			newIsland(),
			input( 5, [ [ 1, 0, 0, 1 ] ] ),
		];

		for ( const message of messages ) {

			expect( decode( JSON.stringify( message ) ) ).toEqual( message );

		}

	} );

	it( 'rejects anything it cannot understand', () => {

		expect( decode( 'not json' ) ).toBeNull();
		expect( decode( '[]' ) ).toBeNull();
		expect( decode( 'null' ) ).toBeNull();
		expect( decode( '{}' ) ).toBeNull();
		expect( decode( '{"t":7}' ) ).toBeNull();
		expect( decode( '{"t":"input"' ) ).toBeNull();
		expect( decode( 42 ) ).toBeNull();
		expect( decode( new Uint8Array() ) ).toBeNull();

	} );

	it( 'decodes binary frames as UTF-8', () => {

		const frame = new TextEncoder().encode( JSON.stringify( respawn() ) );

		expect( decode( frame ) ).toEqual( respawn() );

	} );

	it( 'reads a batch of inputs, numbering them from the base sequence', () => {

		const batch = readInputBatch( input( 10, [ [ 1, 0, 0, 0 ], [ 1, 1, 0, 1 ] ] ) );

		expect( batch.base ).toBe( 10 );
		expect( batch.inputs ).toHaveLength( 2 );
		expect( batch.inputs[ 0 ] ).toEqual( { seq: 10, input: { up: true, down: false, left: false, right: false } } );
		expect( batch.inputs[ 1 ] ).toEqual( { seq: 11, input: { up: true, down: true, left: false, right: true } } );

	} );

	it( 'refuses malformed input batches rather than throwing', () => {

		expect( readInputBatch( { t: 'input' } ) ).toBeNull();
		expect( readInputBatch( { t: 'input', base: - 1, i: [ [ 0, 0, 0, 0 ] ] } ) ).toBeNull();
		expect( readInputBatch( { t: 'input', base: 1.5, i: [ [ 0, 0, 0, 0 ] ] } ) ).toBeNull();
		expect( readInputBatch( { t: 'input', base: 0, i: [] } ) ).toBeNull();
		expect( readInputBatch( { t: 'input', base: 0, i: [ [ 1, 0, 0 ] ] } ) ).toBeNull();
		expect( readInputBatch( { t: 'input', base: 0, i: [ 'nope' ] } ) ).toBeNull();

	} );

	it( 'truncates a batch longer than a client could honestly be ahead by', () => {

		const rows = [];
		for ( let i = 0; i < MULTIPLAYER.maxInputsPerMessage + 5; i ++ ) rows.push( [ 1, 0, 0, 0 ] );

		const batch = readInputBatch( input( 1, rows ) );

		expect( batch.inputs ).toHaveLength( MULTIPLAYER.maxInputsPerMessage );

	} );

	it( 'packs the car flags it needs and nothing else', () => {

		const state = createCarState( field );
		state.airborne = true;
		state.onLand = false;
		state.inWater = true;

		const entry = pose( { state }, 3 );

		expect( readFlags( entry.flags ) ).toEqual( { airborne: true, inWater: true, onLand: false } );
		expect( entry.flags & FLAG.airborne ).toBeTruthy();
		expect( entry.flags & FLAG.onLand ).toBe( 0 );

	} );

	it( 'carries every field a replay needs, and restores all of them', () => {

		const original = createCarState( field );
		original.x = 12.5;
		original.y = 3.25;
		original.z = - 44.5;
		original.heading = 1.75;
		original.speed = 27.5;
		original.steerAngle = - 0.31;
		original.verticalSpeed = - 4.5;
		original.groundSpeed = 2.25;
		original.groundY = 3.1;
		original.waterTime = 0.4;
		original.safeTimer = 0.2;
		original.lastSafe.x = 5;
		original.lastSafe.z = 6;
		original.lastSafe.heading = 0.5;
		original.airborne = true;
		original.inWater = false;
		original.onLand = true;

		const restored = writePoseToState( createCarState( field ), pose( { state: original }, 9 ) );

		for ( const key of [ 'x', 'y', 'z', 'heading', 'speed', 'steerAngle', 'verticalSpeed',
			'groundSpeed', 'groundY', 'waterTime', 'safeTimer', 'airborne', 'inWater', 'onLand' ] ) {

			expect( restored[ key ] ).toBe( original[ key ] );

		}

		expect( restored.lastSafe ).toEqual( original.lastSafe );
		expect( restored.events ).toEqual( [] );

	} );

	it( 'sanitizes names', () => {

		expect( sanitizeName( '  Ana  ' ) ).toBe( 'Ana' );
		expect( sanitizeName( 'a\u0000b\u001fc' ) ).toBe( 'abc' );
		expect( sanitizeName( 'many    spaces' ) ).toBe( 'many spaces' );
		expect( sanitizeName( '' ) ).toBe( 'Driver 1' );
		expect( sanitizeName( '   ' ) ).toBe( 'Driver 1' );
		expect( sanitizeName( null, 4 ) ).toBe( 'Driver 5' );
		expect( sanitizeName( 'x'.repeat( 100 ) ) ).toHaveLength( MULTIPLAYER.nameMaxLength );

	} );

} );