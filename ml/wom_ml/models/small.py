"""방식 A: 처음부터 학습하는 작은 GRU(공통 몸통 + 운동별 머리).

입력 (B,T,17,3) [x,y,conf] -> 프레임마다 51차원을 선형 투영 -> 양방향 GRU 2층
-> 시간 평균·최대 풀링 -> 운동별 선형 머리(오류 칸 수만큼 로짓).
"""
from __future__ import annotations

import torch
from torch import nn


class SmallGRU(nn.Module):
    def __init__(self, heads: dict[str, int], hidden: int = 128, dropout: float = 0.2):
        super().__init__()
        self.embed = nn.Sequential(nn.Linear(17 * 3, hidden), nn.LayerNorm(hidden), nn.GELU())
        # 양방향 GRU 2층 + 층 사이 dropout. nn.GRU(num_layers=2, dropout>0)를 쓰지 않고 풀어 쓴 이유:
        # 이 PC(Windows, torch 2.11+cu126, cuDNN 9.10)에서 cuDNN RNN 내장 dropout을 한 번이라도 쓰면
        # 계산은 끝까지 되지만 프로세스 종료 코드가 127이 된다(os._exit(0)로도 동일, Task 6 수정 1회차에서 확인).
        # 계산은 같다: 1층 출력에 dropout → 2층 입력.
        self.gru1 = nn.GRU(hidden, hidden, batch_first=True, bidirectional=True)
        self.gru2 = nn.GRU(2 * hidden, hidden, batch_first=True, bidirectional=True)
        self.drop = nn.Dropout(dropout)
        self.heads = nn.ModuleDict({ex: nn.Linear(4 * hidden, n) for ex, n in heads.items()})

    def forward(self, x: torch.Tensor, exercise: str) -> torch.Tensor:
        if exercise not in self.heads:
            raise KeyError(f"머리가 없는 운동: {exercise}")
        B, T = x.shape[:2]
        h, _ = self.gru1(self.embed(x.reshape(B, T, -1)))
        h, _ = self.gru2(self.drop(h))
        feat = torch.cat([h.mean(1), h.amax(1)], dim=-1)
        return self.heads[exercise](self.drop(feat))
