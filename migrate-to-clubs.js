/**
 * migrate-to-clubs.js
 *
 * Transforms laguttagning-dev from:
 *   /teams/{teamId}/players|matches|lineups|customFormations
 *   /userSettings/{uid}  { teams: [...] }
 *
 * To:
 *   /clubs/{clubId}/teams/{teamId}/players|lineups|customFormations
 *   /matches/{matchId}  { clubId, teamId, ... }
 *   /userSettings/{uid}  { memberships: [{ clubId, teamId }], ... }
 *
 * Run against laguttagning-dev only — production is untouched.
 */

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = getFirestore('laguttagning-dev');

const ADMIN_UID = 'QLpq1rXHz2gjiipKFCnxEKk5xWx2';

// ── Club definition ─────────────────────────────────
// We create one club "Irsta IF" and map existing teams into it.
const CLUB_ID   = 'irsta-if';
const CLUB_NAME = 'Irsta IF';

// Map existing team IDs → keep same IDs under the club
const TEAM_MAP = {
  'irsta-p12': { name: 'Irsta P12', birthYear: 2012 },
  'ik-oden-p14': { name: 'IK Oden P14', birthYear: 2014 },
};

async function migrate() {
  console.log('Starting club migration in laguttagning-dev\n');

  // ── 1. Create club ──────────────────────────────────
  await db.collection('clubs').doc(CLUB_ID).set({
    name: CLUB_NAME,
    createdBy: ADMIN_UID,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`Created club: ${CLUB_NAME} (${CLUB_ID})`);

  // ── 2. Migrate teams and their subcollections ───────
  const teamsSnap = await db.collection('teams').get();
  if (teamsSnap.empty) {
    console.log('No teams found — nothing to migrate.');
    process.exit(0);
  }

  for (const teamDoc of teamsSnap.docs) {
    const teamId   = teamDoc.id;
    const teamData = teamDoc.data();
    const teamMeta = TEAM_MAP[teamId] || { name: teamData.name, birthYear: teamData.birthYear };

    console.log(`\nMigrating team: ${teamId} (${teamMeta.name})`);

    // Create team under club
    await db.collection('clubs').doc(CLUB_ID)
      .collection('teams').doc(teamId).set({
        name:      teamMeta.name,
        birthYear: teamMeta.birthYear,
        format:    teamData.format || '9v9',
        createdBy: teamData.createdBy || ADMIN_UID,
        createdAt: teamData.createdAt || admin.firestore.FieldValue.serverTimestamp()
      });

    // Migrate players
    const playersSnap = await db.collection('teams').doc(teamId).collection('players').get();
    console.log(`  players: ${playersSnap.size} documents`);
    for (const d of playersSnap.docs) {
      await db.collection('clubs').doc(CLUB_ID)
        .collection('teams').doc(teamId)
        .collection('players').doc(d.id).set(d.data());
    }

    // Migrate lineups
    const lineupsSnap = await db.collection('teams').doc(teamId).collection('lineups').get();
    console.log(`  lineups: ${lineupsSnap.size} documents`);
    for (const d of lineupsSnap.docs) {
      await db.collection('clubs').doc(CLUB_ID)
        .collection('teams').doc(teamId)
        .collection('lineups').doc(d.id).set(d.data());
    }

    // Migrate customFormations
    const formSnap = await db.collection('teams').doc(teamId).collection('customFormations').get();
    console.log(`  customFormations: ${formSnap.size} documents`);
    for (const d of formSnap.docs) {
      await db.collection('clubs').doc(CLUB_ID)
        .collection('teams').doc(teamId)
        .collection('customFormations').doc(d.id).set(d.data());
    }

    // Migrate matches → flat /matches collection with clubId + teamId
    const matchesSnap = await db.collection('teams').doc(teamId).collection('matches').get();
    console.log(`  matches: ${matchesSnap.size} documents → /matches`);
    for (const d of matchesSnap.docs) {
      await db.collection('matches').doc(d.id).set({
        ...d.data(),
        clubId: CLUB_ID,
        teamId: teamId
      });
    }
  }

  // ── 3. Migrate userSettings ─────────────────────────
  console.log('\nMigrating userSettings...');
  const usersSnap = await db.collection('userSettings').get();
  for (const d of usersSnap.docs) {
    const data = d.data();
    const oldTeams = data.teams || [];

    // Build memberships array
    const memberships = oldTeams
      .filter(tid => TEAM_MAP[tid] || teamsSnap.docs.some(t => t.id === tid))
      .map(tid => ({ clubId: CLUB_ID, teamId: tid }));

    await db.collection('userSettings').doc(d.id).set({
      ...data,
      memberships,
      lastClubId: CLUB_ID,
      lastTeamId: data.lastTeam || oldTeams[0] || null,
      // Keep old fields for now, can clean up later
    }, { merge: true });

    console.log(`  ${d.id}: ${memberships.length} memberships`);
  }

  // ── 4. Update admins ────────────────────────────────
  console.log('\nUpdating admins...');
  await db.collection('admins').doc(ADMIN_UID).set({
    email: 'admin',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log('\n✓ Migration complete!');
  console.log('Old /teams collection is still intact — verify data before deleting.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
