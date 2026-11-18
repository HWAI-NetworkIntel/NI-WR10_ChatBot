"use strict";
/** Texas counties that share a border. Used to re-scope a rank scenario. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.adjacentCounties = adjacentCounties;

const NEIGHBORS = {
    houston: ['Anderson', 'Cherokee', 'Angelina', 'Trinity', 'Walker', 'Madison', 'Leon'],
    walker: ['Houston', 'Madison', 'Trinity', 'San Jacinto', 'Grimes', 'Leon'],
    harris: ['Montgomery', 'Liberty', 'Chambers', 'Galveston', 'Brazoria', 'Fort Bend', 'Waller'],
    dallas: ['Collin', 'Denton', 'Tarrant', 'Ellis', 'Kaufman', 'Rockwall'],
    tarrant: ['Dallas', 'Denton', 'Wise', 'Parker', 'Johnson', 'Ellis'],
    bell: ['McLennan', 'Falls', 'Milam', 'Williamson', 'Burnet', 'Lampasas', 'Coryell'],
    mclennan: ['Bell', 'Falls', 'Limestone', 'Hill', 'Bosque', 'Coryell'],
};

function adjacentCounties(county) {
    const key = String(county || '').toLowerCase().replace(/\bcounty\b/g, ' ').replace(/[^a-z]+/g, '').trim();
    return NEIGHBORS[key] ? [...NEIGHBORS[key]] : [];
}
