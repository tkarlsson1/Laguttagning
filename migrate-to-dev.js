const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const prodDb = getFirestore();                    // default = production
const devDb  = getFirestore('laguttagning-dev');  // named database

const SUBCOLLECTIONS = ['players', 'matches', 'lineups', 'customFormations'];

async function copyCollection(srcRef, dstRef, label) {
  const snap = await srcRef.get();
  if (snap.empty) { console.log(`  ${label}: empty, skipping`); return 0; }
  let count = 0;
  for (const d of snap.docs) {
    await dstRef.doc(d.id).set(d.data());
    count++;
  }
  console.log(`  ${label}: ${count} documents copied`);
  return count;
}

async function migrate() {
  console.log('Starting migration: production → laguttagning-dev\n');

  // ── Top-level collections ──────────────────────────
  console.log('Copying admins...');
  await copyCollection(prodDb.collection('admins'), devDb.collection('admins'), 'admins');

  console.log('Copying userSettings...');
  await copyCollection(prodDb.collection('userSettings'), devDb.collection('userSettings'), 'userSettings');

  // ── Teams and subcollections ───────────────────────
  console.log('\nCopying teams...');
  const teamsSnap = await prodDb.collection('teams').get();
  if (teamsSnap.empty) {
    console.log('  No teams found in production!');
  } else {
    for (const teamDoc of teamsSnap.docs) {
      console.log(`\nTeam: ${teamDoc.id} (${teamDoc.data().name})`);
      await devDb.collection('teams').doc(teamDoc.id).set(teamDoc.data());
      for (const col of SUBCOLLECTIONS) {
        await copyCollection(
          prodDb.collection('teams').doc(teamDoc.id).collection(col),
          devDb.collection('teams').doc(teamDoc.id).collection(col),
          col
        );
      }
    }
  }

  console.log('\nMigration complete! Production data is untouched.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
