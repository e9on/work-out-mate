"""오류 칸별 지표와 앱 방식 지표.

y_true·y_pred는 (N, 칸 수) 0/1 배열. y_true가 음수(-1)인 칸은 "그 샘플엔 해당 없음"이라 지표에서 뺀다.
나눗셈의 분모가 0이면 그 값은 0.0으로 둔다(예외·NaN을 내지 않는다).
"""
from __future__ import annotations

import numpy as np


def _div(a: float, b: float) -> float:
    return float(a / b) if b else 0.0


def _check(y_true, y_pred, names):
    yt, yp = np.asarray(y_true), np.asarray(y_pred)
    if yt.shape != yp.shape or yt.ndim != 2 or yt.shape[1] != len(names):
        raise ValueError(f"모양이 맞지 않음: y_true {yt.shape}, y_pred {yp.shape}, 칸 {len(names)}개")
    return yt, yp


def per_error(y_true: np.ndarray, y_pred: np.ndarray, names: list[str]) -> dict[str, dict]:
    """칸별 {precision, recall, f1, tp, fp, fn}."""
    yt, yp = _check(y_true, y_pred, names)
    out = {}
    for j, name in enumerate(names):
        ok = yt[:, j] >= 0
        t, p = yt[ok, j] == 1, yp[ok, j] == 1
        tp, fp, fn = int((t & p).sum()), int((~t & p).sum()), int((t & ~p).sum())
        prec, rec = _div(tp, tp + fp), _div(tp, tp + fn)
        out[name] = {"precision": prec, "recall": rec, "f1": _div(2 * prec * rec, prec + rec),
                     "tp": tp, "fp": fp, "fn": fn}
    return out


def app_style(y_true: np.ndarray, y_pred: np.ndarray, names: list[str]) -> dict:
    """사용자가 느끼는 방식의 두 수치.

    - 일부러 만든 오류(정답에 1이 하나라도 있는 반복) 중, 그 반복의 정답 오류 칸을 하나라도 지적한 수/전체.
    - 오류 없는 반복(정답이 전부 0) 중, 아무 칸이나 지적한 수/전체.
    """
    yt, yp = _check(y_true, y_pred, names)
    valid = (yt >= 0).all(axis=1)
    has_err = valid & (yt == 1).any(axis=1)
    clean = valid & (yt == 0).all(axis=1)
    caught = int(((yt == 1) & (yp == 1)).any(axis=1)[has_err].sum())
    flagged = int((yp == 1).any(axis=1)[clean].sum())
    ne, nc = int(has_err.sum()), int(clean.sum())
    return {"errors_total": ne, "errors_caught": caught, "errors_caught_rate": _div(caught, ne),
            "clean_total": nc, "clean_flagged": flagged, "clean_flagged_rate": _div(flagged, nc)}
