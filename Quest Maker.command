#!/bin/zsh
# Finder에서 더블클릭하면 로컬 서버와 기본 브라우저를 함께 실행합니다.
set -u

QUEST_ROOT="${0:A:h}"
cd "$QUEST_ROOT" || exit 1

if command -v python3 >/dev/null 2>&1; then
  QUEST_PYTHON="$(command -v python3)"
elif [[ -x /opt/homebrew/bin/python3 ]]; then
  QUEST_PYTHON=/opt/homebrew/bin/python3
else
  print 'Python 3를 찾지 못했어요. Python 3 설치 후 다시 열어주세요.'
  read -r '?Enter를 누르면 종료합니다. '
  exit 1
fi

"$QUEST_PYTHON" "$QUEST_ROOT/scripts/launch.py"
quest_exit_code=$?
if (( quest_exit_code != 0 )); then
  print ''
  read -r '?Enter를 누르면 종료합니다. '
fi
exit "$quest_exit_code"
