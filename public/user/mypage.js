(function(){
  'use strict';

  const db = () => firebase.firestore();
  const auth = () => firebase.auth();

  function $(id){ return document.getElementById(id); }
  function escapeHtml(str){
    return String(str ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }
  function fmtDate(d){
    if (!d) return '-';
    const date = d instanceof Date ? d : (d.toDate ? d.toDate() : new Date(d));
    if (!date || isNaN(date.getTime())) return '-';
    const y = date.getFullYear();
    const m = String(date.getMonth()+1).padStart(2,'0');
    const da = String(date.getDate()).padStart(2,'0');
    return `${y}/${m}/${da}`;
  }

  async function loadUserAndLoans(user){
    const userInfoEl = $('userInfo');
    const cardEl = $('mypageUserCard');
    const listEl = $('loansList');
    const summaryEl = $('loansSummary');

    try {
      // ユーザープロファイル
      const userDoc = await db().collection('users').doc(user.uid).get();
      const u = userDoc.data() || {};
      const name = u.name || user.displayName || '(未登録)';
      const id = u.user_id || user.uid;

      if (userInfoEl) {
        userInfoEl.textContent = `${name} (${id})`;
      }
      if (cardEl) {
        cardEl.innerHTML = `
          <p><strong>氏名:</strong> ${escapeHtml(name)}</p>
          <p><strong>ID:</strong> ${escapeHtml(id)}</p>
          <p><strong>区分:</strong> ${escapeHtml(u.role || 'student')}</p>
        `;
      }

      // 貸出中一覧（status=active）
      // 🔥 limit追加: 最大20件に制限（50件→20件）
      let query = db().collection('loans')
        .where('uid','==', user.uid)
        .where('status','==','active')
        .limit(20);
      
      // インデックス完成後は以下のコメントを外してください
      // .orderBy('due_at','asc')
      
      const snap = await query.get();

      if (snap.empty){
        if (summaryEl) summaryEl.textContent = '現在借りている本はありません。';
        if (listEl) listEl.innerHTML = '';
        return;
      }

      const now = new Date();
      const loans = [];
      snap.forEach(doc => {
        const d = doc.data() || {};
        const due = d.due_at;
        const isOverdue = due && ( (due.toDate ? due.toDate() : new Date(due)) < now );
        loans.push({ id: doc.id, ...d, isOverdue });
      });

      // クライアント側でソート（一時的措置）
      loans.sort((a, b) => {
        const aTime = a.due_at ? (a.due_at.toDate ? a.due_at.toDate() : new Date(a.due_at)).getTime() : 0;
        const bTime = b.due_at ? (b.due_at.toDate ? b.due_at.toDate() : new Date(b.due_at)).getTime() : 0;
        return aTime - bTime;
      });

      const total = loans.length;
      const overdueCount = loans.filter(l => l.isOverdue).length;
      if (summaryEl) {
        summaryEl.innerHTML = `
          現在の貸出冊数: <strong>${total}</strong> 冊
          （延滞: <strong style="color:#c62828;">${overdueCount}</strong> 冊）
        `;
      }

      if (listEl) {
        const html = loans.map(l => {
          const dueLabel = fmtDate(l.due_at);
          const statusLabel = l.isOverdue ? '<span class="tag tag-danger">延滞</span>' : '<span class="tag tag-ok">貸出中</span>';
          return `
            <div class="result-card mypage-loan-card">
              <h3>${escapeHtml(l.book_title || '(書名未登録)')}</h3>
              <p class="result-meta"><strong>蔵書ID:</strong> ${escapeHtml(l.book_id || '')}</p>
              <p class="result-meta"><strong>貸出日:</strong> ${fmtDate(l.checked_out_at)}</p>
              <p class="result-meta"><strong>返却期限:</strong> ${dueLabel} ${statusLabel}</p>
            </div>
          `;
        }).join('');
        listEl.innerHTML = html;
      }
    } catch (e){
      console.error(e);
      if (summaryEl) summaryEl.textContent = '情報の取得に失敗しました。時間をおいて再度お試しください。';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    auth().onAuthStateChanged(user => {
      if (!user){
        // guard.js で処理される想定だが、念のため
        location.href = 'login.html';
        return;
      }
      loadUserAndLoans(user);
    });
  });
})();