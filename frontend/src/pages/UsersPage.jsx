import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Users, UserPlus, Edit2, Trash2, X, Shield, ShieldCheck, User, Crown, AlertCircle, Check } from 'lucide-react';

export default function UsersPage() {
    const { user } = useAuth();
    const [usersList, setUsersList] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [editUser, setEditUser] = useState(null);
    const [formError, setFormError] = useState('');
    const [formSuccess, setFormSuccess] = useState('');
    const [formLoading, setFormLoading] = useState(false);

    // Add User form state
    const [addForm, setAddForm] = useState({ name: '', email: '', password: '', role: 'cashier' });
    // Edit User form state
    const [editForm, setEditForm] = useState({ name: '', email: '', role: '', password: '' });

    useEffect(() => {
        fetchUsers();
    }, []);

    const fetchUsers = async () => {
        try {
            const storedToken = localStorage.getItem('token');
            const res = await fetch('/api/users', {
                headers: {
                    'Authorization': `Bearer ${storedToken}`
                }
            });
            if (res.ok) {
                const data = await res.json();
                setUsersList(data.filter(u => u.sync_status !== 'PENDING_DELETE'));
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (targetUser) => {
        // Prevent deleting admin accounts
        if (targetUser.role === 'admin') {
            setFormError('Admin accounts cannot be deleted.');
            setTimeout(() => setFormError(''), 3000);
            return;
        }
        // Prevent deleting yourself
        if (targetUser.id === user?.id) {
            setFormError('You cannot delete your own account.');
            setTimeout(() => setFormError(''), 3000);
            return;
        }
        if (user?.role === 'shop_owner' && targetUser.role !== 'cashier') {
            setFormError('Shop owners can only delete cashiers.');
            setTimeout(() => setFormError(''), 3000);
            return;
        }
        if (!window.confirm(`Are you sure you want to delete "${targetUser.name}"?`)) return;
        try {
            const storedToken = localStorage.getItem('token');
            const res = await fetch(`/api/users/${targetUser.id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${storedToken}`
                }
            });
            if (res.ok) {
                setFormSuccess(`User "${targetUser.name}" deleted successfully.`);
                setTimeout(() => setFormSuccess(''), 3000);
                fetchUsers();
            } else {
                const data = await res.json();
                setFormError(data.error || 'Failed to delete user.');
                setTimeout(() => setFormError(''), 3000);
            }
        } catch (err) {
            console.error(err);
            setFormError('Network error.');
            setTimeout(() => setFormError(''), 3000);
        }
    };

    const handleAddUser = async (e) => {
        e.preventDefault();
        setFormError('');
        setFormLoading(true);
        try {
            const storedToken = localStorage.getItem('token');
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${storedToken}`
                },
                body: JSON.stringify(addForm)
            });
            const data = await res.json();
            if (res.ok) {
                setFormSuccess(`User "${data.name}" created successfully!`);
                setTimeout(() => setFormSuccess(''), 3000);
                setShowAddModal(false);
                setAddForm({ name: '', email: '', password: '', role: 'cashier' });
                fetchUsers();
            } else {
                setFormError(data.error || 'Failed to create user.');
            }
        } catch (err) {
            setFormError('Network error.');
        } finally {
            setFormLoading(false);
        }
    };

    const openEditModal = (targetUser) => {
        // Prevent shop_owner from editing other shop_owners or admin
        if (user?.role === 'shop_owner' && targetUser.role !== 'cashier' && targetUser.id !== user?.id) {
            setFormError('Shop owners can only modify cashiers.');
            setTimeout(() => setFormError(''), 3000);
            return;
        }
        // Admin cannot modify other admins
        if (user?.role === 'admin' && targetUser.role === 'admin' && targetUser.id !== user?.id) {
            setFormError('Cannot modify other admin accounts.');
            setTimeout(() => setFormError(''), 3000);
            return;
        }
        setEditUser(targetUser);
        setEditForm({ name: targetUser.name, email: targetUser.email, role: targetUser.role, password: '' });
        setFormError('');
        setShowEditModal(true);
    };

    const handleEditUser = async (e) => {
        e.preventDefault();
        setFormError('');
        setFormLoading(true);
        try {
            const storedToken = localStorage.getItem('token');
            const body = { name: editForm.name, email: editForm.email, role: editForm.role };
            if (editForm.password) body.password = editForm.password;

            const res = await fetch(`/api/users/${editUser.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${storedToken}`
                },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (res.ok) {
                setFormSuccess(`User "${editForm.name}" updated successfully!`);
                setTimeout(() => setFormSuccess(''), 3000);
                setShowEditModal(false);
                setEditUser(null);
                fetchUsers();
            } else {
                setFormError(data.error || 'Failed to update user.');
            }
        } catch (err) {
            setFormError('Network error.');
        } finally {
            setFormLoading(false);
        }
    };

    const getRoleIcon = (role) => {
        switch (role) {
            case 'admin': return <Crown size={14} className="inline mr-1" />;
            case 'shop_owner': return <ShieldCheck size={14} className="inline mr-1" />;
            default: return <User size={14} className="inline mr-1" />;
        }
    };

    const getRoleBadgeClass = (role) => {
        switch (role) {
            case 'admin': return 'bg-amber-100 text-amber-700 border border-amber-200';
            case 'shop_owner': return 'bg-indigo-100 text-indigo-700 border border-indigo-200';
            default: return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
        }
    };

    const canModify = (targetUser) => {
        if (targetUser.id === user?.id) return true; // Can modify themselves
        if (user?.role === 'admin' && targetUser.role !== 'admin') return true;
        if (user?.role === 'shop_owner' && targetUser.role === 'cashier') return true;
        return false;
    };

    const canDelete = (targetUser) => {
        if (targetUser.id === user?.id) return false;
        if (targetUser.role === 'admin') return false;
        if (user?.role === 'admin') return true;
        if (user?.role === 'shop_owner' && targetUser.role === 'cashier') return true;
        return false;
    };

    const availableRoles = () => {
        if (user?.role === 'admin') return ['admin', 'shop_owner', 'cashier'];
        return ['cashier']; // shop_owner can only create/select cashier
    };

    return (
        <div className="space-y-6">
            {/* Toast Messages */}
            {formError && (
                <div className="fixed top-6 right-6 z-50 bg-rose-50 border border-rose-200 text-rose-700 px-5 py-3 rounded-xl shadow-lg flex items-center space-x-2 animate-slide-in">
                    <AlertCircle size={18} />
                    <span className="text-sm font-medium">{formError}</span>
                </div>
            )}
            {formSuccess && (
                <div className="fixed top-6 right-6 z-50 bg-emerald-50 border border-emerald-200 text-emerald-700 px-5 py-3 rounded-xl shadow-lg flex items-center space-x-2 animate-slide-in">
                    <Check size={18} />
                    <span className="text-sm font-medium">{formSuccess}</span>
                </div>
            )}

            <div className="flex justify-between items-end mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
                    <p className="text-gray-500 mt-1">Manage admin, shop owner, and cashier accounts.</p>
                </div>
                <button
                    onClick={() => { setFormError(''); setShowAddModal(true); }}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-medium shadow-lg shadow-blue-500/30 transition-all flex items-center space-x-2 cursor-pointer"
                >
                    <UserPlus size={18} />
                    <span>Add User</span>
                </button>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                    <h3 className="text-lg font-bold text-gray-900 flex items-center">
                        <Users className="mr-2 text-blue-500" size={20} /> All Users
                    </h3>
                    <span className="text-sm text-gray-400">{usersList.length} user{usersList.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left text-gray-500">
                        <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
                            <tr>
                                <th scope="col" className="px-6 py-3 font-medium">Name</th>
                                <th scope="col" className="px-6 py-3 font-medium">Email</th>
                                <th scope="col" className="px-6 py-3 font-medium">Role</th>
                                <th scope="col" className="px-6 py-3 font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan="4" className="px-6 py-8 text-center">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                        <span>Loading users...</span>
                                    </div>
                                </td></tr>
                            ) : usersList.length === 0 ? (
                                <tr><td colSpan="4" className="px-6 py-8 text-center text-gray-400">No users found.</td></tr>
                            ) : (
                                usersList.map((u) => (
                                    <tr key={u.id} className="bg-white border-b border-gray-50 hover:bg-gray-50/80 transition-colors">
                                        <td className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">
                                            <div className="flex items-center space-x-3">
                                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs uppercase ${u.role === 'admin' ? 'bg-gradient-to-r from-amber-500 to-orange-500' :
                                                    u.role === 'shop_owner' ? 'bg-gradient-to-r from-indigo-500 to-purple-500' :
                                                        'bg-gradient-to-r from-emerald-500 to-teal-500'
                                                    }`}>
                                                    {u.name?.charAt(0) || 'U'}
                                                </div>
                                                <div>
                                                    <p className="font-semibold">{u.name}</p>
                                                    {u.id === user?.id && <span className="text-xs text-blue-500">(You)</span>}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">{u.email}</td>
                                        <td className="px-6 py-4">
                                            <span className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center ${getRoleBadgeClass(u.role)}`}>
                                                {getRoleIcon(u.role)}
                                                {u.role.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex space-x-2">
                                                <button
                                                    onClick={() => openEditModal(u)}
                                                    disabled={!canModify(u)}
                                                    className={`p-2 rounded-lg transition-all cursor-pointer ${canModify(u)
                                                        ? 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
                                                        : 'text-gray-200 cursor-not-allowed'
                                                        }`}
                                                    title={canModify(u) ? 'Edit user' : u.role === 'admin' ? 'Cannot edit admin' : 'Cannot edit'}
                                                >
                                                    <Edit2 size={16} />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(u)}
                                                    disabled={!canDelete(u)}
                                                    className={`p-2 rounded-lg transition-all cursor-pointer ${canDelete(u)
                                                        ? 'text-gray-400 hover:text-rose-600 hover:bg-rose-50'
                                                        : 'text-gray-200 cursor-not-allowed'
                                                        }`}
                                                    title={canDelete(u) ? 'Delete user' : u.role === 'admin' ? 'Cannot delete admin' : 'Cannot delete user'}
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Add User Modal */}
            {showAddModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 w-full max-w-md mx-4 overflow-hidden">
                        <div className="flex justify-between items-center p-6 border-b border-gray-100">
                            <h3 className="text-lg font-bold text-gray-900 flex items-center">
                                <UserPlus className="mr-2 text-blue-500" size={20} /> Add New User
                            </h3>
                            <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer">
                                <X size={20} />
                            </button>
                        </div>
                        <form onSubmit={handleAddUser} className="p-6 space-y-4">
                            {formError && (
                                <div className="bg-rose-50 border border-rose-100 text-rose-600 p-3 rounded-xl flex items-center space-x-2 text-sm">
                                    <AlertCircle size={16} />
                                    <span>{formError}</span>
                                </div>
                            )}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                                <input
                                    type="text"
                                    required
                                    value={addForm.name}
                                    onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors"
                                    placeholder="Enter full name"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                                <input
                                    type="email"
                                    required
                                    value={addForm.email}
                                    onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors"
                                    placeholder="user@example.com"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                                <input
                                    type="password"
                                    required
                                    value={addForm.password}
                                    onChange={(e) => setAddForm({ ...addForm, password: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors"
                                    placeholder="••••••••"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                                <select
                                    value={addForm.role}
                                    onChange={(e) => setAddForm({ ...addForm, role: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors cursor-pointer"
                                >
                                    {availableRoles().map(r => (
                                        <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex justify-end space-x-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowAddModal(false)}
                                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={formLoading}
                                    className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-lg shadow-blue-500/30 transition-all disabled:opacity-60 cursor-pointer"
                                >
                                    {formLoading ? 'Creating...' : 'Create User'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit User Modal */}
            {showEditModal && editUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 w-full max-w-md mx-4 overflow-hidden">
                        <div className="flex justify-between items-center p-6 border-b border-gray-100">
                            <h3 className="text-lg font-bold text-gray-900 flex items-center">
                                <Edit2 className="mr-2 text-blue-500" size={20} /> Edit User
                            </h3>
                            <button onClick={() => { setShowEditModal(false); setEditUser(null); }} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer">
                                <X size={20} />
                            </button>
                        </div>
                        <form onSubmit={handleEditUser} className="p-6 space-y-4">
                            {formError && (
                                <div className="bg-rose-50 border border-rose-100 text-rose-600 p-3 rounded-xl flex items-center space-x-2 text-sm">
                                    <AlertCircle size={16} />
                                    <span>{formError}</span>
                                </div>
                            )}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                                <input
                                    type="text"
                                    required
                                    value={editForm.name}
                                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                                <input
                                    type="email"
                                    required
                                    value={editForm.email}
                                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">New Password <span className="text-gray-400 text-xs">(leave blank to keep current)</span></label>
                                <input
                                    type="password"
                                    value={editForm.password}
                                    onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors"
                                    placeholder="••••••••"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                                <select
                                    disabled={user?.role === 'shop_owner'}
                                    value={editForm.role}
                                    onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 focus:bg-white transition-colors cursor-pointer disabled:opacity-50"
                                >
                                    {availableRoles().includes(editForm.role) && <option value={editForm.role}>{editForm.role.charAt(0).toUpperCase() + editForm.role.slice(1)}</option>}
                                    {availableRoles().map(r => (
                                        r !== editForm.role && <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex justify-end space-x-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => { setShowEditModal(false); setEditUser(null); }}
                                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={formLoading}
                                    className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-lg shadow-blue-500/30 transition-all disabled:opacity-60 cursor-pointer"
                                >
                                    {formLoading ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
