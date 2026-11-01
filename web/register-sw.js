// Check app updates without waiting for account initialization.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {
    const description = document.getElementById('install-description');
    if (description) description.textContent = '오프라인 준비가 끝나지 않았어요. 인터넷 연결을 확인한 뒤 페이지를 다시 열어주세요. 현재 연결에서는 계속 사용할 수 있어요.';
  });
}
