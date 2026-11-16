import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  User as FbUser,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  query,
  where,
} from 'firebase/firestore';
import { auth, db, isFirebaseActive } from './config.ts';
import { Exam, ExamSubmission, UserProfile, UserRole } from '../types.ts';
import { SEED_EXAMS } from '../data/seedExams.ts';

const ADMIN_EMAIL = 'luongphucquang3013@stuni.edu.pl';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function resolveDefaultRole(email: string, emailVerified?: boolean): UserRole {
  if (email.trim().toLowerCase() === ADMIN_EMAIL && emailVerified) {
    return 'teacher';
  }
  return 'student';
}

// Local storage fallback keys (only used when Firebase is not configured)
const LOCAL_USER_KEY = 'smarttest_local_current_user';
const LOCAL_EXAMS_KEY = 'smarttest_local_exams';
const LOCAL_SUBMISSIONS_KEY = 'smarttest_local_submissions';

function initLocalStore() {
  if (!localStorage.getItem(LOCAL_EXAMS_KEY)) {
    localStorage.setItem(LOCAL_EXAMS_KEY, JSON.stringify(SEED_EXAMS));
  }
  if (!localStorage.getItem(LOCAL_SUBMISSIONS_KEY)) {
    localStorage.setItem(LOCAL_SUBMISSIONS_KEY, JSON.stringify([]));
  }
}
initLocalStore();

// ================= AUTHENTICATION =================

export async function loginUser(email: string, password: string): Promise<UserProfile> {
  if (isFirebaseActive && auth && db) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const userPath = `users/${cred.user.uid}`;
    let userDoc;
    try {
      userDoc = await getDoc(doc(db, 'users', cred.user.uid));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, userPath);
    }

    if (userDoc.exists()) {
      const p = userDoc.data() as UserProfile;
      return p;
    }

    const userEmail = cred.user.email || email;
    const fallbackProfile: UserProfile = {
      uid: cred.user.uid,
      email: userEmail.slice(0, 200),
      fullName: (cred.user.displayName || userEmail.split('@')[0] || 'Người dùng').slice(0, 100),
      role: resolveDefaultRole(userEmail, cred.user.emailVerified),
      createdAt: new Date().toISOString(),
    };
    try {
      await setDoc(doc(db, 'users', cred.user.uid), fallbackProfile);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
    return fallbackProfile;
  }

  return loginLocalUser(email);
}

function loginLocalUser(email: string): UserProfile {
  const storedUser = localStorage.getItem(LOCAL_USER_KEY);
  if (storedUser) {
    const u = JSON.parse(storedUser);
    if (u.email.toLowerCase() === email.toLowerCase()) {
      return u;
    }
  }
  const role: UserRole =
    email.includes('teacher') || email.includes('admin') || email.includes('giaovien')
      ? 'teacher'
      : 'student';
  const profile: UserProfile = {
    uid: 'user_' + btoa(email).replace(/=/g, '').slice(0, 8),
    email,
    fullName: email.split('@')[0].toUpperCase(),
    role,
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(profile));
  return profile;
}

export async function registerUser(
  email: string,
  password: string,
  fullName: string,
  _role: UserRole = 'student'
): Promise<UserProfile> {
  if (isFirebaseActive && auth && db) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const userPath = `users/${cred.user.uid}`;
    const userEmail = cred.user.email || email;
    const profile: UserProfile = {
      uid: cred.user.uid,
      email: userEmail.slice(0, 200),
      fullName: (fullName.trim() || 'Người dùng').slice(0, 100),
      role: resolveDefaultRole(userEmail, cred.user.emailVerified),
      createdAt: new Date().toISOString(),
    };
    try {
      await setDoc(doc(db, 'users', cred.user.uid), profile);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
    return profile;
  }

  const profile: UserProfile = {
    uid: 'local_uid_' + Date.now(),
    email,
    fullName: fullName.trim(),
    role: 'student',
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(profile));
  return profile;
}

export async function loginWithGoogle(): Promise<UserProfile> {
  if (isFirebaseActive && auth && db) {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    let cred;
    try {
      cred = await signInWithPopup(auth, provider);
    } catch (fbErr: any) {
      if (fbErr?.code === 'auth/popup-closed-by-user') {
        throw new Error('Bạn đã đóng cửa sổ đăng nhập Google.');
      }
      if (fbErr?.code === 'auth/cancelled-popup-request') {
        throw new Error('Yêu cầu mở cửa sổ đăng nhập đã bị hủy.');
      }
      if (fbErr?.code === 'auth/popup-blocked') {
        throw new Error(
          'Trình duyệt đã chặn cửa sổ popup. Vui lòng cho phép popup để tiếp tục đăng nhập Google.'
        );
      }
      throw fbErr;
    }

    const user = cred.user;
    const userPath = `users/${user.uid}`;
    let userDoc;
    try {
      userDoc = await getDoc(doc(db, 'users', user.uid));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, userPath);
    }

    if (userDoc.exists()) {
      const existingProfile = userDoc.data() as UserProfile;
      // Ensure bootstrapped admin email is recognized as teacher
      if (
        (user.email || '').trim().toLowerCase() === ADMIN_EMAIL &&
        user.emailVerified &&
        existingProfile.role !== 'teacher'
      ) {
        const promoted: UserProfile = { ...existingProfile, role: 'teacher' };
        try {
          await setDoc(doc(db, 'users', user.uid), promoted);
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, userPath);
        }
        return promoted;
      }
      return existingProfile;
    }

    const email = user.email || '';
    const newProfile: UserProfile = {
      uid: user.uid,
      email: email.slice(0, 200),
      fullName: (
        user.displayName ||
        (email ? email.split('@')[0] : 'Người dùng Google')
      ).slice(0, 100),
      role: resolveDefaultRole(email, user.emailVerified),
      createdAt: new Date().toISOString(),
    };

    try {
      await setDoc(doc(db, 'users', user.uid), newProfile);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
    return newProfile;
  }

  return loginLocalGoogleUser();
}

function loginLocalGoogleUser(): UserProfile {
  const email = 'hocsinh.google@thpt.edu.vn';
  const profile: UserProfile = {
    uid: 'google_user_' + Date.now().toString(36),
    email,
    fullName: 'Học sinh Google',
    role: 'student',
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(profile));
  return profile;
}

export async function logoutUser(): Promise<void> {
  if (isFirebaseActive && auth) {
    await fbSignOut(auth);
  }
  localStorage.removeItem(LOCAL_USER_KEY);
}

export function subscribeAuth(callback: (user: UserProfile | null) => void): () => void {
  if (isFirebaseActive && auth && db) {
    return onAuthStateChanged(auth, async (fbUser: FbUser | null) => {
      if (fbUser) {
        const userPath = `users/${fbUser.uid}`;
        try {
          const userDoc = await getDoc(doc(db, 'users', fbUser.uid));
          if (userDoc.exists()) {
            const p = userDoc.data() as UserProfile;
            if (
              (fbUser.email || '').trim().toLowerCase() === ADMIN_EMAIL &&
              fbUser.emailVerified &&
              p.role !== 'teacher'
            ) {
              const promoted: UserProfile = { ...p, role: 'teacher' };
              await setDoc(doc(db, 'users', fbUser.uid), promoted);
              callback(promoted);
              return;
            }
            callback(p);
            return;
          }
          const email = fbUser.email || '';
          const createdProfile: UserProfile = {
            uid: fbUser.uid,
            email: email.slice(0, 200),
            fullName: (fbUser.displayName || (email ? email.split('@')[0] : 'Người dùng')).slice(
              0,
              100
            ),
            role: resolveDefaultRole(email, fbUser.emailVerified),
            createdAt: new Date().toISOString(),
          };
          await setDoc(doc(db, 'users', fbUser.uid), createdProfile);
          callback(createdProfile);
          return;
        } catch (error) {
          console.error('Error syncing user profile:', error);
          callback({
            uid: fbUser.uid,
            email: fbUser.email || '',
            fullName: fbUser.displayName || 'Người dùng',
            role: resolveDefaultRole(fbUser.email || '', fbUser.emailVerified),
            createdAt: new Date().toISOString(),
          });
          return;
        }
      } else {
        callback(null);
      }
    });
  }

  const stored = localStorage.getItem(LOCAL_USER_KEY);
  if (stored) {
    try {
      callback(JSON.parse(stored));
    } catch {
      callback(null);
    }
  } else {
    callback(null);
  }
  return () => {};
}

// ================= EXAMS CRUD =================

export interface FetchExamsOptions {
  publishedOnly?: boolean;
  teacherId?: string;
}

export async function fetchExams(options: FetchExamsOptions = {}): Promise<Exam[]> {
  if (isFirebaseActive && db) {
    const path = 'exams';
    try {
      const examsCol = collection(db, path);
      let q;
      if (options.publishedOnly) {
        q = query(examsCol, where('status', '==', 'published'));
      } else if (options.teacherId) {
        q = query(examsCol, where('teacherId', '==', options.teacherId));
      } else {
        q = examsCol;
      }

      const snap = await getDocs(q);
      const list: Exam[] = [];
      snap.forEach((docItem) => {
        list.push({ id: docItem.id, ...(docItem.data() as any) });
      });
      return list.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  }

  // Local fallback when Firebase is inactive
  const raw = localStorage.getItem(LOCAL_EXAMS_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return SEED_EXAMS;
    }
  }
  return SEED_EXAMS;
}

export async function saveExam(exam: Exam): Promise<Exam> {
  if (isFirebaseActive && db) {
    const examRef = exam.id ? doc(db, 'exams', exam.id) : doc(collection(db, 'exams'));
    const path = `exams/${examRef.id}`;
    const nowIso = new Date().toISOString();
    const finalExam: Exam = {
      id: examRef.id,
      title: String(exam.title || '').trim().slice(0, 200),
      description: String(exam.description || '').trim().slice(0, 2000),
      subject: String(exam.subject || 'Công Nghệ Công Nghiệp').trim().slice(0, 100),
      grade: String(exam.grade || '12').trim().slice(0, 50),
      durationMinutes: Math.min(600, Math.max(1, Number(exam.durationMinutes) || 45)),
      teacherId: String(exam.teacherId || auth?.currentUser?.uid || '').slice(0, 128),
      teacherName: String(exam.teacherName || 'Giáo viên').trim().slice(0, 100),
      status: exam.status || 'published',
      questions: Array.isArray(exam.questions) ? exam.questions.slice(0, 200) : [],
      createdAt: exam.createdAt || nowIso,
      updatedAt: nowIso,
    };

    try {
      await setDoc(examRef, finalExam);
      return finalExam;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }

  // Local fallback
  const exams = await fetchExams();
  const existingIdx = exams.findIndex((e) => e.id === exam.id);
  const finalExam = {
    ...exam,
    id: exam.id || `exam_${Date.now()}`,
    updatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    exams[existingIdx] = finalExam;
  } else {
    exams.unshift(finalExam);
  }
  localStorage.setItem(LOCAL_EXAMS_KEY, JSON.stringify(exams));
  return finalExam;
}

export async function removeExam(examId: string): Promise<void> {
  if (isFirebaseActive && db) {
    const path = `exams/${examId}`;
    try {
      await deleteDoc(doc(db, 'exams', examId));
      return;
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  }

  // Local fallback
  const exams = await fetchExams();
  const filtered = exams.filter((e) => e.id !== examId);
  localStorage.setItem(LOCAL_EXAMS_KEY, JSON.stringify(filtered));
}

// ================= SUBMISSIONS =================

export async function submitExamResult(
  submission: Omit<ExamSubmission, 'id'>
): Promise<ExamSubmission> {
  if (isFirebaseActive && db) {
    const subRef = doc(collection(db, 'submissions'));
    const path = `submissions/${subRef.id}`;
    const newSubmission: ExamSubmission = {
      id: subRef.id,
      examId: String(submission.examId || '').slice(0, 128),
      examTitle: String(submission.examTitle || '').trim().slice(0, 200),
      ...(submission.teacherId ? { teacherId: String(submission.teacherId).slice(0, 128) } : {}),
      studentId: String(submission.studentId || auth?.currentUser?.uid || '').slice(0, 128),
      studentName: String(submission.studentName || 'Học sinh').trim().slice(0, 100),
      studentEmail: String(submission.studentEmail || '').trim().slice(0, 200),
      score: Math.min(10, Math.max(0, Number(submission.score) || 0)),
      earnedRawPoints: Math.max(0, Number(submission.earnedRawPoints) || 0),
      totalMaxRawPoints: Math.max(0, Number(submission.totalMaxRawPoints) || 0),
      correctCount: Math.max(0, Number(submission.correctCount) || 0),
      totalCount: Math.max(0, Number(submission.totalCount) || 0),
      accuracyRate: Math.min(100, Math.max(0, Number(submission.accuracyRate) || 0)),
      durationSpentSeconds: Math.max(0, Number(submission.durationSpentSeconds) || 0),
      answers: submission.answers || {},
      details: Array.isArray(submission.details) ? submission.details.slice(0, 200) : [],
      submittedAt: submission.submittedAt || new Date().toISOString(),
    };

    try {
      await setDoc(subRef, newSubmission);
      return newSubmission;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  const fallbackSubmission: ExamSubmission = {
    ...submission,
    id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
  };
  const raw = localStorage.getItem(LOCAL_SUBMISSIONS_KEY);
  let list: ExamSubmission[] = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {}
  }
  list.unshift(fallbackSubmission);
  localStorage.setItem(LOCAL_SUBMISSIONS_KEY, JSON.stringify(list));
  return fallbackSubmission;
}

export async function fetchSubmissions(
  examId?: string,
  studentId?: string,
  teacherId?: string
): Promise<ExamSubmission[]> {
  if (isFirebaseActive && db) {
    const path = 'submissions';
    try {
      const subsCol = collection(db, path);
      let q;
      if (studentId) {
        q = query(subsCol, where('studentId', '==', studentId));
      } else if (teacherId) {
        q = query(subsCol, where('teacherId', '==', teacherId));
      } else if (examId) {
        q = query(subsCol, where('examId', '==', examId));
      } else {
        q = subsCol;
      }

      const snap = await getDocs(q);
      let list: ExamSubmission[] = [];
      snap.forEach((docItem) => {
        list.push({ id: docItem.id, ...(docItem.data() as any) });
      });

      if (examId) {
        list = list.filter((s) => s.examId === examId);
      }
      if (studentId) {
        list = list.filter((s) => s.studentId === studentId);
      }
      return list.sort(
        (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  }

  // Local fallback
  const raw = localStorage.getItem(LOCAL_SUBMISSIONS_KEY);
  let list: ExamSubmission[] = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {}
  }
  if (examId) {
    list = list.filter((s) => s.examId === examId);
  }
  if (studentId) {
    list = list.filter((s) => s.studentId === studentId);
  }
  return list.sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
  );
}

// ================= APP LOGO MANAGEMENT =================
const LOCAL_LOGO_KEY = 'smarttest_custom_logo';

export function getInitialLogo(): string | null {
  try {
    return localStorage.getItem(LOCAL_LOGO_KEY);
  } catch {
    return null;
  }
}

export async function fetchAppLogo(): Promise<string | null> {
  const local = getInitialLogo();
  if (isFirebaseActive && db && auth?.currentUser) {
    const path = 'settings/branding';
    try {
      const docRef = doc(db, 'settings', 'branding');
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        if (data.logoUrl) {
          localStorage.setItem(LOCAL_LOGO_KEY, data.logoUrl);
          return data.logoUrl;
        } else if (data.logoUrl === null) {
          localStorage.removeItem(LOCAL_LOGO_KEY);
          return null;
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  }
  return local;
}

export async function saveAppLogo(logoDataUrl: string): Promise<void> {
  try {
    localStorage.setItem(LOCAL_LOGO_KEY, logoDataUrl);
  } catch (e) {
    console.error('Failed to store logo in localStorage:', e);
  }
  window.dispatchEvent(new CustomEvent('smarttest_logo_changed', { detail: logoDataUrl }));

  if (isFirebaseActive && db) {
    const path = 'settings/branding';
    try {
      const docRef = doc(db, 'settings', 'branding');
      await setDoc(docRef, {
        logoUrl: String(logoDataUrl).slice(0, 900000),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export async function resetAppLogo(): Promise<void> {
  try {
    localStorage.removeItem(LOCAL_LOGO_KEY);
  } catch (e) {
    console.error('Failed to remove logo from localStorage:', e);
  }
  window.dispatchEvent(new CustomEvent('smarttest_logo_changed', { detail: null }));

  if (isFirebaseActive && db) {
    const path = 'settings/branding';
    try {
      const docRef = doc(db, 'settings', 'branding');
      await setDoc(docRef, {
        logoUrl: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export function subscribeAppLogo(callback: (logoUrl: string | null) => void): () => void {
  callback(getInitialLogo());

  if (auth?.currentUser) {
    fetchAppLogo()
      .then((logo) => callback(logo))
      .catch(() => {});
  }

  const handler = (e: any) => {
    callback(e.detail ?? null);
  };

  window.addEventListener('smarttest_logo_changed', handler);
  return () => {
    window.removeEventListener('smarttest_logo_changed', handler);
  };
}
