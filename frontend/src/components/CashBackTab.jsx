import React, { useState, useEffect, useMemo } from 'react';
import { Banknote, Calendar, Search, Trash2, AlertTriangle, CheckCircle2, User, Phone, IdCard } from 'lucide-react';

const validateNIC = (nic) => {
    if (!nic) return true;
    return /^\d{9}[vVxX]$/.test(nic) || /^\d{12}$/.test(nic);
};
const formatNIC = (nic) => (nic ? nic.toUpperCase() : '');
const KEY = 'pos_cashback_records';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (r) => { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch {} };
const isPast = (d) => { if (!d) return false; const t = new Date(); t.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); return x <= t; };
const days = (d) => { if (!d) return null; const t = new Date(); t.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); return Math.round((x - t) / 86400000); };

export default function CashBackTab({ products = [] }) 