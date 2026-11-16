import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { FirebaseCustomConfig } from '../types.ts';

export const FIREBASE_CONFIG: FirebaseCustomConfig = {
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  projectId: firebaseConfig.projectId,
  storageBucket: firebaseConfig.storageBucket,
  messagingSenderId: firebaseConfig.messagingSenderId,
  appId: firebaseConfig.appId,
  ...(firebaseConfig.measurementId ? { measurementId: firebaseConfig.measurementId } : {}),
};

// Dọn dẹp key cũ trong LocalStorage để tránh xung đột
try {
  localStorage.removeItem('smarttest_firebase_config');
} catch {}

let appInstance = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const authInstance: Auth = getAuth(appInstance);
const firestoreInstance: Firestore = getFirestore(
  appInstance,
  firebaseConfig.firestoreDatabaseId
);

async function testConnection() {
  try {
    await getDocFromServer(doc(firestoreInstance, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export const auth = authInstance;
export const db = firestoreInstance;
export const isFirebaseActive = Boolean(firebaseConfig.projectId && firebaseConfig.apiKey);
export const activeProjectId = firebaseConfig.projectId;
export const DEFAULT_FIREBASE_CONFIG = FIREBASE_CONFIG;

// Compatibility stubs
export function getSavedFirebaseConfig(): FirebaseCustomConfig {
  return FIREBASE_CONFIG;
}
export function saveFirebaseConfig(_config: FirebaseCustomConfig) {}
export function clearFirebaseConfig() {}
