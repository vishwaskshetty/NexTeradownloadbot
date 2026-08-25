"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJobKeyboard = void 0;
const telegraf_1 = require("telegraf");
const getJobKeyboard = (jobId) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('❌ Cancel', `cancel_${jobId}`)]
    ]);
};
exports.getJobKeyboard = getJobKeyboard;
