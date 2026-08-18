'use strict';

const db = require('../database/client');
const { cleanString } = require('./validation');

async function uniqueSlug(name) {
  const base = cleanString(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  let slug = base;
  let suffix = 2;
  while (await db.get('SELECT id FROM organizations WHERE slug=?', [slug])) slug = `${base}-${suffix++}`;
  return slug;
}

module.exports = { uniqueSlug };
