import { describe, expect, it } from 'vitest';
import { buildCar } from '../src/car/carModel.js';
import { CAR, COLORS } from '../src/config.js';

describe( 'buildCar', () => {

	it( 'builds four wheels, all of them steerable where they should be', () => {

		const car = buildCar();

		expect( car.wheels ).toHaveLength( 4 );
		expect( car.steerPivots ).toHaveLength( 2 );       // the front pair
		expect( car.wheelOffsets ).toHaveLength( 4 );
		expect( car.suspension ).toHaveLength( 4 );
		expect( car.chassis.children.length ).toBeGreaterThan( 10 );

	} );

	it( 'wears the paint it was given', () => {

		const car = buildCar( { color: 0x123456 } );

		expect( paintOf( car ) ).toBe( 0x123456 );

	} );

	it( 'defaults to the one player paint', () => {

		expect( paintOf( buildCar() ) ).toBe( COLORS.carPaint );

	} );

	it( 'can be repainted, which is how a room hands out colours', () => {

		const car = buildCar();

		car.setPaint( 0xff00ff );

		expect( paintOf( car ) ).toBe( 0xff00ff );

	} );

	it( 'hangs each wheel at its rest height, so suspension has something to move', () => {

		for ( const node of buildCar().suspension ) {

			expect( node.baseY ).toBe( CAR.wheelRadius );

		}

	} );

} );

/**
 * Reads the body's paint colour off the built car.
 *
 * The hull is the first part added to the chassis, and it is the one carrying the paint
 * material; the wheels and their steer pivots are added after it.
 *
 * @param {object} car Car from `buildCar()`.
 * @returns {number} Hex colour.
 */
function paintOf( car ) {

	return car.chassis.children[ 0 ].material.color.getHex();

}