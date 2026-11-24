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
        self.gru = nn.GRU(hidden, hidden, num_layers=2, batch_first=True, bidirectional=True,
                          dropout=dropout)
        self.drop = nn.Dropout(dropout)
        self.heads = nn.ModuleDict({ex: nn.Linear(4 * hidden, n) for ex, n in heads.items()})

    def forward(self, x: torch.Tensor, exercise: str) -> torch.Tensor:
        if exercise not in self.heads:
            raise KeyError(f"머리가 없는 운동: {exercise}")
        B, T = x.shape[:2]
        h, _ = self.gru(self.embed(x.reshape(B, T, -1)))
        feat = torch.cat([h.mean(1), h.amax(1)], dim=-1)
        return self.heads[exercise](self.drop(feat))
