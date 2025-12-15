(function () {
  'use strict';

  const db = () => firebase.firestore();
  const ts = () => firebase.firestore.FieldValue.serverTimestamp();

  function $(id) { return document.getElementById(id); }
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setMsg(id, msg, isError = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#c62828' : '#2e7d32';
  }

  async function addUser() {
    const userId = ($("userId")?.value || '').trim();
    const name = ($("userName")?.value || '').trim();
    const role = ($("userRole")?.value || '').trim() || 'student';

    if (!userId || !name) {
      setMsg('userAddMessage', 'ユーザーIDと氏名を入力してください。', true);
      return;
    }

    setMsg('userAddMessage', '登録中...');
    try {
      await db().collection('users').doc(userId).set({
        user_id: userId,
        name,
        name_lc: name.toLowerCase(),
        role,
        created_at: ts(),
      }, { merge: true });
      setMsg('userAddMessage', '登録しました。');
    } catch (e) {
      console.error(e);
      setMsg('userAddMessage', e.message || '登録に失敗しました。', true);
    }
  }

  async function searchUsers() {
    const termRaw = ($("userSearchTerm")?.value || '').trim();
    const term = termRaw.toLowerCase();
    const container = $("usersContainer");
    if (!term || term.length < 2) {
      container.innerHTML = '<p>2文字以上で検索してください。</p>';
      return;
    }

    container.innerHTML = '検索中...';

    try {
      // 1) user_id 完全一致
      const idSnap = await db().collection('users')
        .where('user_id', '==', termRaw)
        .limit(1)
        .get();

      let users = [];
      if (!idSnap.empty) {
        users = idSnap.docs.map(d => d.data());
      } else {
        // 2) name_lc 前方一致
        const nameSnap = await db().collection('users')
          .orderBy('name_lc')
          .startAt(term)
          .endAt(term + '\uf8ff')
          .limit(50)
          .get();
        users = nameSnap.docs.map(d => d.data());
      }

      if (!users.length) {
        container.innerHTML = '<p>該当する利用者は見つかりませんでした。</p>';
        return;
      }

      const html = users.map(u => `
        <div class="result-card">
          <p class="result-meta"><strong>ID:</strong> ${escapeHtml(u.user_id)}</p>
          <p class="result-meta"><strong>氏名:</strong> ${escapeHtml(u.name)}</p>
          <p class="result-meta"><strong>区分:</strong> ${escapeHtml(u.role || '-')}</p>
        </div>
      `).join('');

      container.innerHTML = html;
    } catch (e) {
      console.error(e);
      container.innerHTML = '<p>検索中にエラーが発生しました。</p>';
    }
  }

  // 公開
  window.addUser = addUser;
  window.searchUsers = searchUsers;
})();
