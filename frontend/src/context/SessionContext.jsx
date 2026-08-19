import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';

const SessionContext = createContext(null);

export const SessionProvider = ({ children }) => {
    const { user, loading: authLoading } = useAuth();
    const [session, setSession] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchCurrentSession = useCallback(async () => {
        if (!user) {
            setSession(null);
            setLoading(false);
            return;
        }

        const token = localStorage.getItem('token');
        if (!token) {
            setLoading(false);
            return;
        }

        try {
            const res = await fetch('http://localhost:5000/api/sessions/current', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setSession(data);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (!authLoading) {
            fetchCurrentSession();
        }
    }, [authLoading, fetchCurrentSession]);

    const openSession = async (openingCash, openingReload) => {
        const token = localStorage.getItem('token');
        const res = await fetch('http://localhost:5000/api/sessions/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ openingCash, openingReload })
        });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to open session');
        }
        const data = await res.json();
        setSession(data);
        return data;
    };

    const closeSession = async (actualCash, actualReload) => {
        if (!session) return;
        const token = localStorage.getItem('token');
        const res = await fetch('http://localhost:5000/api/sessions/close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ id: session.id, actualCash, actualReload })
        });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to close session');
        }
        const data = await res.json();
        setSession(null); // Clear from context
        return data;
    };

    return (
        <SessionContext.Provider value={{ session, isOpen: !!session, loading: loading || authLoading, openSession, closeSession, fetchCurrentSession }}>
            {children}
        </SessionContext.Provider>
    );
};

export const useSession = () => useContext(SessionContext);
