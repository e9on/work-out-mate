import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App', () => {
  it('홈 제목 "Work Out Mate"가 보인다', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Work Out Mate' })).toBeInTheDocument();
  });
});
