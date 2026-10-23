import { describe, expect, it } from 'vitest';
import { readableColor } from '../src/multiplayer/remoteCars.js';
import { MULTIPLAYER } from '../src/config.js';

/** Relative luminance of a `#rrggbb` string, the same measure the tag lighting uses. */
function luminance( css ) {

	const r = parseInt( css.slice( 1, 3 ), 16 );
	const g = parseInt( css.slice( 3, 5 ), 16 );
	const b = parseInt( css.slice( 5, 7 ), 16 );

	return ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) / 255;

}

describe( 'readableColor', () => {

	it( 'makes every paint in the palette legible on the dark tag', () => {

		for ( const color of MULTIPLAYER.colors ) {

			expect( luminance( readableColor( color ) ) ).toBeGreaterThan( 0.6 );

		}

	} );

	it( 'leaves a colour that is already light alone', () => {

		// White stays white, and the pale yellow stays itself.
		expect( readableColor( 0xffffff ) ).toBe( '#ffffff' );
		expect( readableColor( MULTIPLAYER.colors[ 2 ] ) ).toBe( '#f2c230' );

	} );

	it( 'lightens a dark colour without turning it grey or white', () => {

		const lifted = readableColor( 0x2f6fd0 ); // the blue

		expect( lifted ).not.toBe( '#2f6fd0' );
		expect( lifted ).not.toBe( '#ffffff' );

		// Still recognisably blue: the channel order survives.
		const r = parseInt( lifted.slice( 1, 3 ), 16 );
		const g = parseInt( lifted.slice( 3, 5 ), 16 );
		const b = parseInt( lifted.slice( 5, 7 ), 16 );
		expect( b ).toBeGreaterThan( r );
		expect( b ).toBeGreaterThan( g );

	} );

} );