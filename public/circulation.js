(function () {
  'use strict';

  const LOAN_PERIOD_DAYS = 14;
  const db = () => firebase.firestore();
  const auth = () => firebase.auth();
  const ts = () => firebase.firestore.FieldValue.serverTimestamp();

  let currentUser = null;
  let currentContext = null; // { bookId, bookData, hasActiveLoan, activeLoanDocId }

  function getEl(id) { return document.getElementById(id); }
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    if (!d) return '-';
    const date = d instanceof Date ? d : (d.toDate ? d.toDate() : new Date(d));
    return `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
  }

  function addDays(base, days) {
    const d = base instanceof Date ? new Date(base) : new Date();
    d.setDate(d.getDate() + days);
    return d;
  }

  // ユーザー情報の取得と表示
  async function loadUserInfo() {
    try {
      const user = auth().currentUser;
      if (!user) {
        getEl('userInfo').innerHTML = '<span style="color: #c62828;">ログインが必要です</span>';
        return;
      }

      const userDoc = await db().collection('users').doc(user.uid).get();
      const userData = userDoc.data() || {};
      currentUser = { uid: user.uid, ...userData };

      getEl('userInfo').innerHTML = `
        <p><strong>ユーザー:</strong> ${escapeHtml(userData.name || user.displayName || 'Unknown')}</p>
        <p><strong>ID:</strong> ${escapeHtml(userData.user_id || user.uid)}</p>
        <p><strong>権限:</strong> ${escapeHtml(userData.role || 'student')}</p>
      `;
    } catch (error) {
      console.error('ユーザー情報取得エラー:', error);
      getEl('userInfo').innerHTML = '<span style="color: #c62828;">ユーザー情報の取得に失敗しました</span>';
    }
  }

  // ここから追加: スキャン結果に応じた情報表示と操作
  function renderBookInfoCard(ctx){
    const { bookId, bookData, hasActiveLoan } = ctx;
    const section = getEl('bookInfoSection');
    const card = getEl('bookInfoCard');
    if (!section || !card) return;

    const available = Number(bookData.available_count ?? 0);
    const stock = Number(bookData.stock_count ?? bookData.total_copies ?? 0);

    // 予約数と先頭予約者の取得（表示用）
    const reservedFor = bookData.next_reserved_for || '';
    const reservationsCount = Number(bookData.reservations_count ?? 0);

    card.innerHTML = `
      <div>
        <h3>${escapeHtml(bookData.title || '不明な書名')}</h3>
        <p><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
        <p><strong>ISBN:</strong> ${escapeHtml(bookData.isbn13 || bookData.isbn || '-')}</p>
        <p><strong>著者:</strong> ${escapeHtml(bookData.authors || bookData.author || '-')}</p>
        <p><strong>出版社:</strong> ${escapeHtml(bookData.publisher || '-')}</p>
        <p><strong>在庫:</strong> 残り ${available} / 登録 ${stock}</p>
        <p><strong>予約:</strong> ${reservationsCount} 件${reservedFor ? `（先頭: ${escapeHtml(reservedFor)}）` : ''}</p>
        ${bookData.thumbnail ? `<img src="${bookData.thumbnail}" alt="cover" style="max-height:120px;border-radius:6px;margin-top:6px;">` : ''}
      </div>
    `;

    const checkoutBtn = getEl('checkoutBtn');
    const returnBtn = getEl('returnBtn');
    const reserveBtn = getEl('reserveBtn');
    if (checkoutBtn) checkoutBtn.style.display = (!hasActiveLoan && available > 0) ? 'inline-block' : 'none';
    if (returnBtn) returnBtn.style.display = hasActiveLoan ? 'inline-block' : 'none';
    if (reserveBtn) reserveBtn.style.display = (!hasActiveLoan && available <= 0) ? 'inline-block' : 'none';

    section.style.display = 'block';
  }

  async function onScanBookFound(bookObj, meta, identifier){
    // 識別子表示
    const scanSection = getEl('scanResultSection');
    if (scanSection) scanSection.style.display = 'block';
    const raw = getEl('rawOcrText');
    if (raw) raw.textContent = identifier;

    if (!auth().currentUser) {
      alert('ログインが必要です');
      return;
    }

    if (!bookObj){
      // 未登録
      currentContext = null;
      const card = getEl('bookInfoCard');
      const section = getEl('bookInfoSection');
      if (card) card.innerHTML = `<p>識別子: ${escapeHtml(identifier)}</p><p>該当する蔵書が見つかりませんでした。</p>`;
      if (section) section.style.display = 'block';
      const checkoutBtn = getEl('checkoutBtn');
      const returnBtn = getEl('returnBtn');
      if (checkoutBtn) checkoutBtn.style.display = 'none';
      if (returnBtn) returnBtn.style.display = 'none';
      return;
    }

    // 最新データ取得
    const bookRef = db().collection('books').doc(bookObj.id);
    const bookSnap = await bookRef.get();
    const bookData = bookSnap.data() || bookObj.data || {};

    // 予約数を数える（簡易集計）
    try {
      const rs = await db().collection('reservations')
        .where('book_id','==', bookObj.id)
        .where('status','==','active')
        .get();
      bookData.reservations_count = rs.size;
    } catch(e){ /* 表示用なので失敗は無視 */ }

    // ユーザの貸出状態確認
    const q = await db().collection('loans')
      .where('uid','==', auth().currentUser.uid)
      .where('book_id','==', bookObj.id)
      .where('status','==','active')
      .limit(1)
      .get();

    const hasActiveLoan = !q.empty;
    const activeLoanDocId = hasActiveLoan ? q.docs[0].id : null;

    currentContext = { bookId: bookObj.id, bookData, hasActiveLoan, activeLoanDocId };
    renderBookInfoCard(currentContext);
  }

  // 二重確認付きの貸出
  async function checkoutCurrent(){
    if (!currentContext){ return; }
    if (!confirm('この本を貸し出します。よろしいですか？')) return;

    const { bookId } = currentContext;
    const user = auth().currentUser;
    if (!user){ alert('ログインが必要です'); return; }

    const bookRef = db().collection('books').doc(bookId);

    try {
      await db().runTransaction(async (tx)=>{
        const bSnap = await tx.get(bookRef);
        if (!bSnap.exists) throw new Error('蔵書が見つかりません');
        const data = bSnap.data() || {};
        const available = Number(data.available_count ?? data.available_copies ?? 0);

        // 先行予約がある場合は、先頭予約者のみ貸出可能
        const nextReservedFor = data.next_reserved_for || '';
        if (nextReservedFor && nextReservedFor !== user.uid) {
          throw new Error('先行予約があり、貸出できません');
        }

        if (available <= 0) throw new Error('在庫がありません');

        // 在庫を減らす
        tx.update(bookRef, { available_count: available - 1, updated_at: ts(), next_reserved_for: null });

        // もしユーザーが予約済みなら、予約を消化（完了にする）
        const rSnap = await db().collection('reservations')
          .where('book_id','==', bookId)
          .where('uid','==', user.uid)
          .where('status','==','active')
          .limit(1)
          .get();
        if (!rSnap.empty){
          tx.update(rSnap.docs[0].ref, { status: 'fulfilled', fulfilled_at: ts() });
        }

        // 貸出レコード
        const loanRef = db().collection('loans').doc();
        const dueDate = addDays(new Date(), LOAN_PERIOD_DAYS);
        tx.set(loanRef, {
          uid: user.uid,
          book_id: bookId,
          isbn13: data.isbn13 || null,
          book_title: data.title || '',
          checked_out_at: ts(),
          due_at: dueDate,
          returned_at: null,
          status: 'active',
          created_at: ts()
        });
      });

      const b = await db().collection('books').doc(bookId).get();
      currentContext.bookData = b.data() || currentContext.bookData;
      currentContext.hasActiveLoan = true;
      renderBookInfoCard(currentContext);

      showActionResult('📤 貸出完了', `<p><strong>書名:</strong> ${escapeHtml(currentContext.bookData.title || '')}</p>`, 'success');
    } catch (e){
      console.error(e);
      showActionResult('貸出失敗', `<p>${escapeHtml(e.message || '処理に失敗しました')}</p>`, 'error');
    }
  }

  // 二重確認付きの返却
  async function returnCurrent(){
    if (!currentContext){ return; }
    if (!confirm('この本を返却します。よろしいですか？')) return;

    const { bookId } = currentContext;
    const user = auth().currentUser;
    if (!user){ alert('ログインが必要です'); return; }

    const bookRef = db().collection('books').doc(bookId);

    try {
      const q = await db().collection('loans')
        .where('uid','==', user.uid)
        .where('book_id','==', bookId)
        .where('status','==','active')
        .limit(1)
        .get();

      if (q.empty) throw new Error('このユーザーのアクティブな貸出が見つかりません');
      const loanDoc = q.docs[0].ref;

      await db().runTransaction(async (tx)=>{
        const bSnap = await tx.get(bookRef);
        if (!bSnap.exists) throw new Error('蔵書が見つかりません');
        const data = bSnap.data() || {};
        const available = Number(data.available_count ?? data.available_copies ?? 0);
        const stock = Number(data.stock_count ?? data.total_copies ?? 0);
        let nextAvailable = Math.min(stock || (available + 1), available + 1);

        // 返却時、予約が存在すれば先頭予約者に優先権を付与
        const rs = await db().collection('reservations')
          .where('book_id','==', bookId)
          .where('status','==','active')
          .orderBy('created_at','asc')
          .limit(1)
          .get();
        let nextReservedFor = null;
        if (!rs.empty){
          const r0 = rs.docs[0].data();
          nextReservedFor = r0.uid;
          // 在庫は返却されても、予約者優先のため 1 冊はロック扱いにする
          nextAvailable = Math.max(0, nextAvailable - 1);
        }

        tx.update(bookRef, { available_count: nextAvailable, updated_at: ts(), next_reserved_for: nextReservedFor || null });
        tx.update(loanDoc, { status: 'returned', returned_at: ts() });
      });

      const b = await db().collection('books').doc(bookId).get();
      currentContext.bookData = b.data() || currentContext.bookData;
      currentContext.hasActiveLoan = false;
      renderBookInfoCard(currentContext);

      showActionResult('📥 返却完了', `<p><strong>書名:</strong> ${escapeHtml(currentContext.bookData.title || '')}</p>`, 'success');
    } catch (e){
      console.error(e);
      showActionResult('返却失敗', `<p>${escapeHtml(e.message || '処理に失敗しました')}</p>`, 'error');
    }
  }

  // 予約作成
  async function reserveCurrent(){
    if (!currentContext){ return; }
    const user = auth().currentUser;
    if (!user){ alert('ログインが必要です'); return; }

    const { bookId } = currentContext;
    if (!confirm('この本を予約します。よろしいですか？')) return;

    try {
      // 既存予約の重複チェック
      const exists = await db().collection('reservations')
        .where('book_id','==', bookId)
        .where('uid','==', user.uid)
        .where('status','==','active')
        .limit(1)
        .get();
      if (!exists.empty){
        showActionResult('予約済み', 'この本は既に予約済みです。', 'warning');
        return;
      }

      await db().collection('reservations').add({
        uid: user.uid,
        book_id: bookId,
        status: 'active',
        created_at: ts()
      });

      // 本側の予約件数を更新（簡易）
      const bookRef = db().collection('books').doc(bookId);
      await db().runTransaction(async (tx)=>{
        const s = await tx.get(bookRef);
        const d = s.data() || {};
        const cnt = Number(d.reservations_count ?? 0) + 1;
        tx.update(bookRef, { reservations_count: cnt, updated_at: ts() });
      });

      showActionResult('予約完了', '予約を受け付けました。入荷次第、先頭予約者に優先権が付与されます。', 'success');
    } catch(e){
      console.error(e);
      showActionResult('予約失敗', `<p>${escapeHtml(e.message || '処理に失敗しました')}</p>`, 'error');
    }
  }

  function restartScan(){
    // UIリセット
    const section = getEl('bookInfoSection');
    const card = getEl('bookInfoCard');
    if (card) card.innerHTML = '';
    if (section) section.style.display = 'none';
    const checkoutBtn = getEl('checkoutBtn');
    const returnBtn = getEl('returnBtn');
    const reserveBtn = getEl('reserveBtn');
    if (checkoutBtn) checkoutBtn.style.display = 'none';
    if (returnBtn) returnBtn.style.display = 'none';
    if (reserveBtn) reserveBtn.style.display = 'none';

    // スキャナ再開
    if (typeof startCamera === 'function') startCamera();
  }

  // 複数の識別子候補を表示して選択可能にする
  function displayIdentifierCandidates(text, candidates) {
    const section = getEl('scanResultSection');
    const rawTextEl = getEl('rawOcrText');
    const selectionEl = getEl('identifierSelection');

    rawTextEl.textContent = text;
    
    if (candidates.length === 0) {
      selectionEl.innerHTML = '<p style="color: #c62828;">識別子が検出されませんでした</p>';
    } else if (candidates.length === 1) {
      selectionEl.innerHTML = `
        <div class="identifier-candidate selected" data-id="${escapeHtml(candidates[0])}">
          <strong>${escapeHtml(candidates[0])}</strong>
          <span class="auto-selected">(自動選択)</span>
        </div>
      `;
      // 単一候補の場合は自動処理
      setTimeout(() => processSelectedIdentifier(candidates[0]), 500);
    } else {
      const candidateHTML = candidates.map(candidate => `
        <div class="identifier-candidate" data-id="${escapeHtml(candidate)}" onclick="selectIdentifier('${escapeHtml(candidate)}')">
          ${escapeHtml(candidate)}
        </div>
      `).join('');
      
      selectionEl.innerHTML = `
        <p>複数の識別子が検出されました。選択してください：</p>
        ${candidateHTML}
      `;
    }

    section.style.display = 'block';
  }

  // 識別子選択
  function selectIdentifier(selectedId) {
    // 他の候補の選択を解除
    document.querySelectorAll('.identifier-candidate').forEach(el => {
      el.classList.remove('selected');
    });
    
    // 選択されたものをハイライト
    document.querySelector(`[data-id="${selectedId}"]`).classList.add('selected');
    
    // 処理実行
    processSelectedIdentifier(selectedId);
  }

  // 選択された識別子を処理
  async function processSelectedIdentifier(bookId) {
    if (!currentUser) {
      await loadUserInfo();
      if (!currentUser) {
        showActionResult('エラー', 'ユーザー情報が取得できません。再ログインしてください。', 'error');
        return;
      }
    }

    showActionResult('処理中', `識別子 ${bookId} を処理しています...`, 'processing');

    try {
      // 1. 蔵書の存在確認
      const bookDoc = await findBookDocByBookId(bookId);
      
      if (bookDoc) {
        // 蔵書が存在する場合：貸出状況を確認
        await handleExistingBook(bookDoc, bookId);
      } else {
        // 蔵書が存在しない場合：新規登録
        await handleNewBook(bookId);
      }
    } catch (error) {
      console.error('処理エラー:', error);
      showActionResult('エラー', `処理中にエラーが発生しました: ${error.message}`, 'error');
    }
  }

  // 既存蔵書の処理（貸出 or 返却）
  async function handleExistingBook(bookDoc, bookId) {
    const bookData = bookDoc.data();
    
    // ユーザーが現在この本を借りているかチェック
    const currentLoanSnap = await db().collection('loans')
      .where('user_id', '==', currentUser.user_id || currentUser.uid)
      .where('book_id', '==', bookId)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (!currentLoanSnap.empty) {
      // 返却処理
      await returnBook(bookDoc, bookId, currentLoanSnap.docs[0]);
    } else {
      // 貸出処理
      await checkoutBook(bookDoc, bookId);
    }
  }

  // 新規蔵書の登録と貸出
  async function handleNewBook(bookId) {
    const title = prompt('新しい本を登録します。書名を入力してください:', `書名不明 (ID: ${bookId})`);
    if (!title) {
      showActionResult('キャンセル', '登録をキャンセルしました。', 'info');
      return;
    }

    // 新規蔵書を登録
    const bookData = {
      book_id: bookId,
      title: title,
      author: '不明',
      location: '未分類',
      total_copies: 1,
      available_copies: 0, // 即座に貸出するので0
      created_at: ts(),
      updated_at: ts(),
      registered_by: currentUser.user_id || currentUser.uid
    };

    await db().collection('books').doc(bookId).set(bookData);

    // 即座に貸出レコードも作成
    const loanRef = db().collection('loans').doc();
    const dueDate = addDays(new Date(), LOAN_PERIOD_DAYS);
    
    await loanRef.set({
      user_id: currentUser.user_id || currentUser.uid,
      book_id: bookId,
      book_ref: bookId,
      book_title: title,
      checked_out_at: ts(),
      due_at: dueDate,
      returned_at: null,
      status: 'active'
    });

    showActionResult(
      '📚 新規登録 & 貸出完了',
      `
        <p><strong>書名:</strong> ${escapeHtml(title)}</p>
        <p><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
        <p><strong>貸出者:</strong> ${escapeHtml(currentUser.name || 'Unknown')}</p>
        <p><strong>返却期限:</strong> ${fmtDate(dueDate)}</p>
        <p class="success">新しい本を登録して貸出しました。</p>
      `,
      'success'
    );
  }

  // 貸出処理
  async function checkoutBook(bookDoc, bookId) {
    const bookData = bookDoc.data();
    const available = Number(bookData.available_copies ?? 0);

    if (available <= 0) {
      showActionResult('貸出不可', `「${escapeHtml(bookData.title)}」は現在貸出中です。`, 'error');
      return;
    }

    await db().runTransaction(async (tx) => {
      const fresh = await tx.get(bookDoc.ref);
      const data = fresh.data() || {};
      const currentAvailable = Number(data.available_copies ?? 0);
      
      if (currentAvailable <= 0) throw new Error('在庫がありません');

      // 在庫を1減らす
      tx.update(bookDoc.ref, { available_copies: currentAvailable - 1 });

      // 貸出レコード作成
      const loanRef = db().collection('loans').doc();
      const dueDate = addDays(new Date(), LOAN_PERIOD_DAYS);
      
      tx.set(loanRef, {
        user_id: currentUser.user_id || currentUser.uid,
        book_id: bookId,
        book_ref: bookDoc.ref.id,
        book_title: bookData.title,
        checked_out_at: ts(),
        due_at: dueDate,
        returned_at: null,
        status: 'active'
      });
    });

    const dueDate = addDays(new Date(), LOAN_PERIOD_DAYS);
    showActionResult(
      '📤 貸出完了',
      `
        <p><strong>書名:</strong> ${escapeHtml(bookData.title)}</p>
        <p><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
        <p><strong>貸出者:</strong> ${escapeHtml(currentUser.name || 'Unknown')}</p>
        <p><strong>返却期限:</strong> ${fmtDate(dueDate)}</p>
        <p class="success">貸出が完了しました。</p>
      `,
      'success'
    );
  }

  // 返却処理
  async function returnBook(bookDoc, bookId, loanDoc) {
    const bookData = bookDoc.data();
    const loanData = loanDoc.data();

    await db().runTransaction(async (tx) => {
      const fresh = await tx.get(bookDoc.ref);
      const data = fresh.data() || {};
      const available = Number(data.available_copies ?? 0);
      const total = Number(data.total_copies ?? 0);
      const nextAvailable = Math.min(total, available + 1);

      tx.update(bookDoc.ref, { available_copies: nextAvailable });
      tx.update(loanDoc.ref, { status: 'returned', returned_at: ts() });
    });

    // 延滞チェック
    const dueDate = loanData.due_at?.toDate ? loanData.due_at.toDate() : new Date(loanData.due_at);
    const isOverdue = dueDate && dueDate < new Date();

    showActionResult(
      '📥 返却完了',
      `
        <p><strong>書名:</strong> ${escapeHtml(bookData.title)}</p>
        <p><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
        <p><strong>返却者:</strong> ${escapeHtml(currentUser.name || 'Unknown')}</p>
        <p><strong>貸出日:</strong> ${fmtDate(loanData.checked_out_at)}</p>
        <p><strong>返却期限:</strong> ${fmtDate(dueDate)}</p>
        ${isOverdue ? '<p class="error"><strong>⚠️ 延滞返却です</strong></p>' : '<p class="success">期限内返却です</p>'}
      `,
      isOverdue ? 'warning' : 'success'
    );
  }

  // 蔵書検索
  async function findBookDocByBookId(bookId) {
    const snap = await db().collection('books').where('book_id', '==', bookId).limit(1).get();
    return snap.empty ? null : snap.docs[0];
  }

  // 結果表示
  function showActionResult(title, content, type = 'info') {
    const section = getEl('actionResultSection');
    const resultEl = getEl('actionResult');
    
    let className = 'result-card';
    let icon = '📋';
    
    switch (type) {
      case 'success': className += ' success'; icon = '✅'; break;
      case 'error': className += ' error'; icon = '❌'; break;
      case 'warning': className += ' warning'; icon = '⚠️'; break;
      case 'processing': className += ' processing'; icon = '⏳'; break;
    }
    
    resultEl.className = className;
    resultEl.innerHTML = `
      <h3>${icon} ${escapeHtml(title)}</h3>
      <div>${content}</div>
    `;
    
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth' });
  }

  // 手動入力処理
  async function processManualInput() {
    const bookId = (getEl('manualBookId')?.value || '').trim();
    const title = (getEl('manualTitle')?.value || '').trim();
    
    if (!bookId) {
      getEl('manualResult').textContent = '蔵書IDを入力してください。';
      getEl('manualResult').style.color = '#c62828';
      return;
    }

    // 手動入力の場合も同じロジックを使用
    if (title) {
      // タイトルが入力されている場合は強制的に新規登録
      await handleNewBookWithTitle(bookId, title);
    } else {
      await processSelectedIdentifier(bookId);
    }

    // フィールドクリア
    getEl('manualBookId').value = '';
    getEl('manualTitle').value = '';
    getEl('manualResult').textContent = '';
  }

  // タイトル指定での新規登録
  async function handleNewBookWithTitle(bookId, title) {
    const bookData = {
      book_id: bookId,
      title: title,
      author: '不明',
      location: '未分類',
      total_copies: 1,
      available_copies: 0,
      created_at: ts(),
      updated_at: ts(),
      registered_by: currentUser.user_id || currentUser.uid
    };

    await db().collection('books').doc(bookId).set(bookData);

    const loanRef = db().collection('loans').doc();
    const dueDate = addDays(new Date(), LOAN_PERIOD_DAYS);
    
    await loanRef.set({
      user_id: currentUser.user_id || currentUser.uid,
      book_id: bookId,
      book_ref: bookId,
      book_title: title,
      checked_out_at: ts(),
      due_at: dueDate,
      returned_at: null,
      status: 'active'
    });

    showActionResult(
      '📚 手動登録 & 貸出完了',
      `
        <p><strong>書名:</strong> ${escapeHtml(title)}</p>
        <p><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
        <p><strong>返却期限:</strong> ${fmtDate(dueDate)}</p>
      `,
      'success'
    );
  }

  // グローバル関数として公開
  window.selectIdentifier = selectIdentifier;
  window.processManualInput = processManualInput;
  window.displayIdentifierCandidates = displayIdentifierCandidates;
  window.onScanBookFound = onScanBookFound;
  window.checkoutCurrent = checkoutCurrent;
  window.returnCurrent = returnCurrent;
  window.reserveCurrent = reserveCurrent;
  window.restartScan = restartScan;

  // 初期化
  document.addEventListener('DOMContentLoaded', () => {
    auth().onAuthStateChanged(user => {
      if (user) {
        loadUserInfo();
      }
    });
  });

})();