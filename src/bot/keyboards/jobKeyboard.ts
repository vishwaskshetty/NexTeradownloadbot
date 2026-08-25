import { Markup } from 'telegraf';

export const getJobKeyboard = (jobId: string) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', `cancel_${jobId}`)]
  ]);
};
