import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';

const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const positiveNumber = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export function registerCoinixMarket(app, { db, verifyToken, verifyAdmin }) {
  const ready = (req, res, next) => db ? next() : res.status(503).json({ success: false, code: 'DATABASE_UNAVAILABLE' });

  app.get('/api/market/tasks', ready, async (req, res) => {
    try {
      const type = ['telegram', 'offerwall'].includes(req.query.type) ? req.query.type : null;
      let query = db.collection('coinix_market_tasks').where('status', '==', 'active');
      if (type) query = query.where('type', '==', type);
      const snap = await query.limit(100).get();
      res.json({ success: true, tasks: snap.docs.map(doc => {
        const d = doc.data();
        return { id: doc.id, type: d.type, title: d.title, description: d.description, reward: d.reward,
          maxParticipants: d.maxParticipants, completedCount: d.completedCount || 0, targetUrl: d.targetUrl || null, provider: d.provider || null };
      }) });
    } catch (error) {
      console.error('Coinix market list error:', error);
      res.status(500).json({ success: false, message: 'Could not load tasks' });
    }
  });

  app.post('/api/market/tasks', ready, verifyToken, async (req, res) => {
    try {
      const title = cleanText(req.body.title, 90);
      const description = cleanText(req.body.description, 600);
      const targetUrl = cleanText(req.body.targetUrl, 500);
      const reward = positiveNumber(req.body.reward);
      const maxParticipants = Math.floor(positiveNumber(req.body.maxParticipants));
      if (!title || !description || !/^https:\/\/(t\.me|telegram\.me)\//i.test(targetUrl) || !reward || reward > 1000000 || !maxParticipants || maxParticipants > 10000) {
        return res.status(400).json({ success: false, message: 'Valid Telegram URL, title, description, reward and participant limit are required.' });
      }
      const budget = Number((reward * maxParticipants).toFixed(8));
      const taskRef = db.collection('coinix_market_tasks').doc();
      const ownerRef = db.collection('users').doc(req.user.uid);
      await db.runTransaction(async tx => {
        const ownerSnap = await tx.get(ownerRef);
        if (!ownerSnap.exists) throw new Error('USER_NOT_FOUND');
        const available = Number(ownerSnap.data().coinixAvailable || 0);
        if (available < budget) throw new Error('INSUFFICIENT_COINIX_BUDGET');
        tx.update(ownerRef, { coinixAvailable: Number((available - budget).toFixed(8)), coinixEscrowed: FieldValue.increment(budget) });
        tx.create(taskRef, { type: 'telegram', ownerId: req.user.uid, title, description, targetUrl, reward, maxParticipants,
          completedCount: 0, reservedCount: 0, budget, remainingBudget: budget, status: 'pending_review', createdAt: FieldValue.serverTimestamp() });
      });
      res.status(201).json({ success: true, taskId: taskRef.id, status: 'pending_review', reservedBudget: budget });
    } catch (error) {
      if (error.message === 'INSUFFICIENT_COINIX_BUDGET') return res.status(400).json({ success: false, code: error.message, message: 'Not enough available COINIX to reserve this task budget.' });
      if (error.message === 'USER_NOT_FOUND') return res.status(404).json({ success: false, message: 'User not found' });
      console.error('Coinix task create error:', error);
      res.status(500).json({ success: false, message: 'Could not create task' });
    }
  });

  app.post('/api/market/tasks/:taskId/submit', ready, verifyToken, async (req, res) => {
    try {
      const proof = cleanText(req.body.proof, 1200);
      if (!proof) return res.status(400).json({ success: false, message: 'Proof or Telegram username is required.' });
      const taskRef = db.collection('coinix_market_tasks').doc(req.params.taskId);
      const submissionRef = taskRef.collection('submissions').doc(req.user.uid);
      await db.runTransaction(async tx => {
        const [taskSnap, previous] = await Promise.all([tx.get(taskRef), tx.get(submissionRef)]);
        if (!taskSnap.exists || taskSnap.data().status !== 'active') throw new Error('TASK_NOT_AVAILABLE');
        if (previous.exists) throw new Error('ALREADY_SUBMITTED');
        const task = taskSnap.data();
        if ((task.reservedCount || 0) >= task.maxParticipants) throw new Error('TASK_FULL');
        tx.create(submissionRef, { userId: req.user.uid, proof, status: 'pending', reward: task.reward, createdAt: FieldValue.serverTimestamp() });
        tx.update(taskRef, { reservedCount: FieldValue.increment(1) });
      });
      res.status(201).json({ success: true, status: 'pending_review' });
    } catch (error) {
      const known = { TASK_NOT_AVAILABLE: [404, 'Task is not available'], ALREADY_SUBMITTED: [409, 'You have already submitted this task'], TASK_FULL: [409, 'All task places have been reserved'] };
      if (known[error.message]) return res.status(known[error.message][0]).json({ success: false, code: error.message, message: known[error.message][1] });
      console.error('Coinix task submit error:', error);
      res.status(500).json({ success: false, message: 'Could not submit task' });
    }
  });

  app.post('/api/admin/market/tasks/:taskId/activate', verifyAdmin, ready, async (req, res) => {
    try {
      const ref = db.collection('coinix_market_tasks').doc(req.params.taskId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().status !== 'pending_review') return res.status(404).json({ success: false, message: 'Pending task not found' });
      await ref.update({ status: 'active', reviewedAt: FieldValue.serverTimestamp() });
      res.json({ success: true, status: 'active' });
    } catch (error) {
      console.error('Coinix task activation error:', error);
      res.status(500).json({ success: false, message: 'Could not activate task' });
    }
  });

  app.post('/api/admin/market/tasks/:taskId/submissions/:userId/decision', verifyAdmin, ready, async (req, res) => {
    try {
      const decision = req.body.decision;
      if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ success: false, message: 'Decision must be approve or reject' });
      const taskRef = db.collection('coinix_market_tasks').doc(req.params.taskId);
      const submissionRef = taskRef.collection('submissions').doc(req.params.userId);
      const userRef = db.collection('users').doc(req.params.userId);
      await db.runTransaction(async tx => {
        const taskSnap = await tx.get(taskRef);
        if (!taskSnap.exists) throw new Error('RECORD_NOT_FOUND');
        const ownerRef = db.collection('users').doc(taskSnap.data().ownerId);
        const [submissionSnap, userSnap, ownerSnap] = await Promise.all([tx.get(submissionRef), tx.get(userRef), tx.get(ownerRef)]);
        if (!submissionSnap.exists || !userSnap.exists || !ownerSnap.exists) throw new Error('RECORD_NOT_FOUND');
        const submission = submissionSnap.data();
        if (submission.status !== 'pending') throw new Error('ALREADY_REVIEWED');
        if (decision === 'approve') {
          const reward = Number(submission.reward);
          tx.update(userRef, { coinixAvailable: FieldValue.increment(reward) });
          tx.update(ownerRef, { coinixEscrowed: FieldValue.increment(-reward) });
          tx.update(taskRef, { completedCount: FieldValue.increment(1), remainingBudget: FieldValue.increment(-reward) });
          tx.update(submissionRef, { status: 'approved', reviewedAt: FieldValue.serverTimestamp() });
          tx.create(db.collection('coinix_ledger').doc(), { userId: req.params.userId, taskId: req.params.taskId, amount: reward, type: 'task_reward', createdAt: FieldValue.serverTimestamp() });
        } else {
          tx.update(taskRef, { reservedCount: FieldValue.increment(-1) });
          tx.update(submissionRef, { status: 'rejected', reviewedAt: FieldValue.serverTimestamp() });
        }
      });
      res.json({ success: true, status: decision === 'approve' ? 'approved' : 'rejected' });
    } catch (error) {
      if (['RECORD_NOT_FOUND', 'ALREADY_REVIEWED'].includes(error.message)) return res.status(409).json({ success: false, code: error.message });
      console.error('Coinix submission decision error:', error);
      res.status(500).json({ success: false, message: 'Could not review submission' });
    }
  });

  app.post('/api/market/offerwall/postback', ready, async (req, res) => {
    try {
      const secret = process.env.OFFERWALL_POSTBACK_SECRET;
      const signature = req.get('x-coinix-signature') || '';
      if (!secret || !req.rawBody || !signature) return res.status(503).json({ success: false, message: 'Offerwall callback is not configured' });
      const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
      const supplied = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) return res.status(401).json({ success: false, message: 'Invalid signature' });
      const { userId, transactionId, reward, status, provider } = req.body || {};
      const amount = positiveNumber(reward);
      if (!userId || !transactionId || !amount || status !== 'completed' || !cleanText(provider, 60)) return res.status(400).json({ success: false, message: 'Invalid completed offer payload' });
      const eventId = crypto.createHash('sha256').update(String(provider) + ':' + String(transactionId)).digest('hex');
      const eventRef = db.collection('coinix_offerwall_events').doc(eventId);
      const userRef = db.collection('users').doc(String(userId));
      await db.runTransaction(async tx => {
        const [eventSnap, userSnap] = await Promise.all([tx.get(eventRef), tx.get(userRef)]);
        if (eventSnap.exists) throw new Error('DUPLICATE_EVENT');
        if (!userSnap.exists) throw new Error('USER_NOT_FOUND');
        tx.create(eventRef, { userId: String(userId), transactionId: String(transactionId), provider: String(provider), reward: amount, createdAt: FieldValue.serverTimestamp() });
        tx.update(userRef, { coinixAvailable: FieldValue.increment(amount) });
        tx.create(db.collection('coinix_ledger').doc(), { userId: String(userId), amount, type: 'offerwall_reward', provider: String(provider), transactionId: String(transactionId), createdAt: FieldValue.serverTimestamp() });
      });
      res.json({ success: true, credited: amount });
    } catch (error) {
      if (error.message === 'DUPLICATE_EVENT') return res.status(409).json({ success: false, code: error.message, message: 'This provider transaction was already processed.' });
      if (error.message === 'USER_NOT_FOUND') return res.status(404).json({ success: false, message: 'User not found' });
      console.error('Coinix offerwall callback error:', error);
      res.status(500).json({ success: false, message: 'Could not process offerwall callback' });
    }
  });
}
