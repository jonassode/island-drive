import { describe, expect, it } from 'vitest';
import { pickColor } from '../src/multiplayer/palette.js';
import { MULTIPLAYER } from '../src/config.js';

describe( 'pickColor', () => {

	it( 'never repeats a colour while the palette lasts', () => {

		const taken = [];

		for ( let i = 0; i < MULTIPLAYER.colors.length; i ++ ) {

			const color = pickColor( taken );

			expect( taken ).not.toContain( color );
			taken.push( color );

		}

		expect( new Set( taken ).size ).toBe( MULTIPLAYER.colors.length );

	} );

	it( 'only ever returns palette colours', () => {

		for ( let i = 0; i < 200; i ++ ) {

			expect( MULTIPLAYER.colors ).toContain( pickColor( [ 0xd93b2b ] ) );

		}

	} );

	it( 'still answers when the palette is exhausted', () => {

		const color = pickColor( [ ...MULTIPLAYER.colors ] );

		expect( MULTIPLAYER.colors ).toContain( color );

	} );

	it( 'is driven by the injected random source', () => {

		const first = () => 0;
		const last = () => 0.999999;

		expect( pickColor( [], { random: first } ) ).toBe( MULTIPLAYER.colors[ 0 ] );
		expect( pickColor( [], { random: last } ) ).toBe( MULTIPLAYER.colors[ MULTIPLAYER.colors.length - 1 ] );

		// With everything but the last colour taken, both ends of the range land on it.
		const taken = MULTIPLAYER.colors.slice( 0, - 1 );
		expect( pickColor( taken, { random: first } ) ).toBe( MULTIPLAYER.colors[ MULTIPLAYER.colors.length - 1 ] );
		expect( pickColor( taken, { random: last } ) ).toBe( MULTIPLAYER.colors[ MULTIPLAYER.colors.length - 1 ] );

	} );

	it( 'gives every player in a full room a different colour', () => {

		const taken = [];

		for ( let i = 0; i < MULTIPLAYER.maxPlayers; i ++ ) taken.push( pickColor( taken ) );

		expect( new Set( taken ).size ).toBe( MULTIPLAYER.maxPlayers );

	} );

} );