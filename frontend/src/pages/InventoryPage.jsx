import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Package, Search, Plus, Smartphone, Settings, AlertTriangle, X, Pencil, Trash2 } from 'lucide-react';

export default function InventoryPage() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';

    const [activeTab, setActiveTab] = useState('phones');
    const [phones, setPhones] = useState([]);
    const [accessories, setAccessories] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(true);

    const [showModal, setShowModal] = useState(false);
    const [editingItem, setEditingItem] = useState(null);
    const [formData, setFormData] = useState({});
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        fetchInventory();
    }, [activeTab]);

    const fetchInventory = async () => {
        setLoading(true);
        try {
            const storedToken = localStorage.getItem('token');
            const endpoint = activeTab === 'phones' ? 'phones' : 'accessories';
            const res = await fetch(`/api/inventory/${endpoint}`, {
                headers: { 'Authorization': `Bearer ${storedToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (activeTab === 'phones') setPhones(data);
                else setAccessories(data);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleAddItem = async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            const storedToken = localStorage.getItem('token');
            const endpoint = activeTab === 'phones' ? 'phones' : 'accessories';

            const res = await fetch(`/api/inventory/${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${storedToken}`
                },
                body: JSON.stringify(formData)
            });

            if (res.ok) {
                setShowModal(false);
                setFormData({});
                setEditingItem(null);
                fetchInventory();
            } else {
                const errData = await res.json().catch(() => ({}));
                alert(errData.error || "Failed to add item");
            }
        } catch (err) {
            console.error(err);
            alert("Error adding item");
        } finally {
            setSubmitting(false);
        }
    };

    const handleEditItem = (item) => {
        setEditingItem(item);
        setFormData({ ...item });
        setShowModal(true);
    };

    const handleUpdateItem = async (e) => {
        e.preventDefault();
        if (!editingItem) return;
        setSubmitting(true);
        try {
            const storedToken = localStorage.getItem('token');
            const endpoint = activeTab === 'phones' ? 'phones' : 'accessories';

            const res = await fetch(`/api/inventory/${endpoint}/${editingItem.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${storedToken}`
                },
                body: JSON.stringify(formData)
            });

            if (res.ok) {
                setShowModal(false);
                setFormData({});
                setEditingItem(null);
                fetchInventory();
            } else {
                const errData = await res.json().catch(() => ({}));
                alert(errData.error || "Failed to update item");
            }
        } catch (err) {
            console.error(err);
            alert("Error updating item");
        } finally {
            setSubmitting(false);
        }
    };

    const handleDeleteItem = async (item) => {
        const itemName = activeTab === 'phones' ? `${item.brand} ${item.model} (${item.imei})` : `${item.name} (${item.sku})`;
        if (!window.confirm(`Are you sure you want to delete "${itemName}"? This action cannot be undone.`)) return;

        try {
            const storedToken = localStorage.getItem('token');
            const endpoint = activeTab === 'phones' ? 'phones' : 'accessories';

            const res = await fetch(`/api/inventory/${endpoint}/${item.id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${storedToken}`
                }
            });

            if (res.ok) {
                fetchInventory();
            } else {
                const errData = await res.json().catch(() => ({}));
                alert(errData.error || "Failed to delete item");
            }
        } catch (err) {
            console.error(err);
            alert("Error deleting item");
        }
    };

    const handleSubmit = (e) => {
        if (editingItem) {
            handleUpdateItem(e);
        } else {
            handleAddItem(e);
        }
    };

    const closeModal = () => {
        setShowModal(false);
        setFormData({});
        setEditingItem(null);
    };

    const filteredPhones = phones.filter(p =>
        p.imei.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.brand.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const filteredAccessories = accessories.filter(a =>
        a.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
        a.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const lowStockItems = activeTab === 'accessories' ? accessories.filter(a => a.quantity <= a.low_stock_threshold) : [];

    return (
        <div className="space-y-6 relative">
            <div className="flex justify-between items-end mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Inventory Management</h1>
                    <p className="text-gray-500 mt-1">Manage phones, accessories, and spare parts.</p>
                </div>
                {isAdmin && (
                    <button
                        onClick={() => { setFormData({}); setEditingItem(null); setShowModal(true); }}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-medium shadow-lg shadow-blue-500/30 transition-all flex items-center space-x-2"
                    >
                        <Plus size={18} />
                        <span>Add Item</span>
                    </button>
                )}
            </div>

            {lowStockItems.length > 0 && (
                <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-start space-x-3 shadow-sm">
                    <AlertTriangle className="text-rose-500 mt-0.5" size={20} />
                    <div>
                        <h4 className="text-rose-800 font-bold">Low Stock Alert</h4>
                        <p className="text-rose-600 text-sm">{lowStockItems.length} items are running low on stock and need reordering.</p>
                    </div>
                </div>
            )}

            {/* Tabs */}
            <div className="flex space-x-1 bg-white p-1 rounded-xl shadow-sm border border-gray-100 max-w-md">
                <button
                    onClick={() => { setActiveTab('phones'); setSearchTerm(''); }}
                    className={`flex-1 flex justify-center items-center space-x-2 py-2.5 rounded-lg font-medium transition-all ${activeTab === 'phones' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                >
                    <Smartphone size={18} />
                    <span>Phones</span>
                </button>
                <button
                    onClick={() => { setActiveTab('accessories'); setSearchTerm(''); }}
                    className={`flex-1 flex justify-center items-center space-x-2 py-2.5 rounded-lg font-medium transition-all ${activeTab === 'accessories' ? 'bg-amber-50 text-amber-700' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
                >
                    <Settings size={18} />
                    <span>Accessories & Parts</span>
                </button>
            </div>

            {/* Controls */}
            <div className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                <div className="relative w-full max-w-md">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Search size={18} className="text-gray-400" />
                    </div>
                    <input
                        type="text"
                        className="block w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg leading-5 bg-gray-50 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-blue-500 focus:ring-blue-500 sm:text-sm transition-colors"
                        placeholder={activeTab === 'phones' ? "Search by IMEI, Brand, or Model..." : "Search by SKU or Name..."}
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                    <Package className="text-gray-400" size={18} />
                    <span>Total: {activeTab === 'phones' ? filteredPhones.length : filteredAccessories.length} items</span>
                </div>
            </div>

            {/* Table grid */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="overflow-x-auto">
                    {activeTab === 'phones' ? (
                        <table className="w-full text-sm text-left text-gray-500">
                            <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
                                <tr>
                                    <th scope="col" className="px-6 py-3 font-medium">IMEI</th>
                                    <th scope="col" className="px-6 py-3 font-medium">Model</th>
                                    <th scope="col" className="px-6 py-3 font-medium">Condition</th>
                                    {isAdmin && <th scope="col" className="px-6 py-3 font-medium">Cost (Rs.)</th>}
                                    <th scope="col" className="px-6 py-3 font-medium">Sell Price (Rs.)</th>
                                    <th scope="col" className="px-6 py-3 font-medium">Warranty</th>
                                    <th scope="col" className="px-6 py-3 font-medium">Status</th>
                                    {isAdmin && <th scope="col" className="px-6 py-3 font-medium text-right">Actions</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr><td colSpan={isAdmin ? 8 : 6} className="px-6 py-8 text-center text-gray-400">Loading Phones...</td></tr>
                                ) : filteredPhones.map((p) => (
                                    <tr key={p.id} className="bg-white border-b border-gray-50 hover:bg-gray-50/80 transition-colors">
                                        <td className="px-6 py-4 font-mono text-xs text-gray-900 whitespace-nowrap">{p.imei}</td>
                                        <td className="px-6 py-4">
                                            <div className="font-semibold text-gray-900">{p.brand} {p.model}</div>
                                            <div className="text-xs text-gray-400">{p.category}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`px-2.5 py-1 rounded-md text-xs font-medium ${p.condition === 'New' ? 'bg-indigo-100 text-indigo-700' : 'bg-orange-100 text-orange-700'}`}>{p.condition}</span>
                                        </td>
                                        {isAdmin && <td className="px-6 py-4 font-medium text-gray-500">{p.purchase_price ? p.purchase_price.toLocaleString() : '-'}</td>}
                                        <td className="px-6 py-4 font-semibold text-gray-900">{p.selling_price.toLocaleString()}</td>
                                        <td className="px-6 py-4 text-gray-500">{p.warranty || 'None'}</td>
                                        <td className="px-6 py-4">
                                            <span className={`px-2.5 py-1 rounded-md text-xs font-medium ${p.status === 'In Stock' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{p.status}</span>
                                        </td>
                                        {isAdmin && (
                                            <td className="px-6 py-4">
                                                <div className="flex justify-end space-x-2">
                                                    <button
                                                        onClick={() => handleEditItem(p)}
                                                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                                        title="Edit"
                                                    >
                                                        <Pencil size={16} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteItem(p)}
                                                        className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                                                        title="Delete"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <table className="w-full text-sm text-left text-gray-500">
                            <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
                                <tr>
                                    <th scope="col" className="px-6 py-3 font-medium">SKU</th>
                                    <th scope="col" className="px-6 py-3 font-medium">Name & Category</th>
                                    <th scope="col" className="px-6 py-3 font-medium text-center">Qty / Min</th>
                                    {isAdmin && <th scope="col" className="px-6 py-3 font-medium">Cost (Rs.)</th>}
                                    <th scope="col" className="px-6 py-3 font-medium">Sell Price (Rs.)</th>
                                    {isAdmin && <th scope="col" className="px-6 py-3 font-medium text-right">Actions</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr><td colSpan={isAdmin ? 6 : 4} className="px-6 py-8 text-center text-gray-400">Loading Accessories...</td></tr>
                                ) : filteredAccessories.map((a) => (
                                    <tr key={a.id} className="bg-white border-b border-gray-50 hover:bg-gray-50/80 transition-colors">
                                        <td className="px-6 py-4 font-mono text-xs text-gray-900 whitespace-nowrap">{a.sku}</td>
                                        <td className="px-6 py-4">
                                            <div className="font-semibold text-gray-900">{a.name}</div>
                                            <div className="text-xs text-gray-400">{a.category}</div>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <div className="flex items-center justify-center space-x-1 text-xs">
                                                <span className={`font-bold text-sm ${a.quantity <= a.low_stock_threshold ? 'text-rose-600 bg-rose-100 px-2 rounded' : 'text-gray-900'}`}>{a.quantity}</span>
                                                <span className="text-gray-400">/ {a.low_stock_threshold}</span>
                                            </div>
                                        </td>
                                        {isAdmin && <td className="px-6 py-4 font-medium text-gray-500">{a.cost_price ? a.cost_price.toLocaleString() : '-'}</td>}
                                        <td className="px-6 py-4 font-semibold text-gray-900">{a.sell_price.toLocaleString()}</td>
                                        {isAdmin && (
                                            <td className="px-6 py-4">
                                                <div className="flex justify-end space-x-2">
                                                    <button
                                                        onClick={() => handleEditItem(a)}
                                                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                                        title="Edit"
                                                    >
                                                        <Pencil size={16} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteItem(a)}
                                                        className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                                                        title="Delete"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {/* Add/Edit Modal */}
            {showModal && (
                <div className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-[999]">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                            <h3 className="text-lg font-bold text-gray-900">
                                {editingItem ? `Edit ${activeTab === 'phones' ? 'Phone' : 'Accessory/Part'}` : `Add ${activeTab === 'phones' ? 'New Phone' : 'Accessory/Part'}`}
                            </h3>
                            <button onClick={closeModal} className="text-gray-400 hover:text-gray-600">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto flex-1">
                            <form id="add-form" className="space-y-4" onSubmit={handleSubmit}>

                                {activeTab === 'phones' ? (
                                    <>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">IMEI</label>
                                                <input required type="text" name="imei" value={formData.imei || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                                                <select required name="category" value={formData.category || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300">
                                                    <option value="">Select Category</option>
                                                    <option value="New Phones">New Phones</option>
                                                    <option value="Used Phones">Used Phones</option>
                                                </select>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Brand</label>
                                                <input required type="text" name="brand" value={formData.brand || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                                                <input required type="text" name="model" value={formData.model || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Condition</label>
                                                <select required name="condition" value={formData.condition || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300">
                                                    <option value="">Select Condition</option>
                                                    <option value="New">New</option>
                                                    <option value="Used-A">Used-A</option>
                                                    <option value="Used-B">Used-B</option>
                                                    <option value="Used-C">Used-C</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Warranty</label>
                                                <input type="text" name="warranty" value={formData.warranty || ''} onChange={handleInputChange} placeholder="e.g. 1 Year" className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Purchase Price</label>
                                                <input type="number" name="purchase_price" value={formData.purchase_price || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Selling Price</label>
                                                <input required type="number" name="selling_price" value={formData.selling_price || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                                            <select name="status" value={formData.status || 'In Stock'} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300">
                                                <option value="In Stock">In Stock</option>
                                                <option value="Sold">Sold</option>
                                            </select>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
                                                <input required type="text" name="sku" value={formData.sku || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                                                <select required name="category" value={formData.category || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300">
                                                    <option value="">Select Category</option>
                                                    <option value="Accessories">Accessories</option>
                                                    <option value="Spare Parts">Spare Parts</option>
                                                </select>
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                                            <input required type="text" name="name" value={formData.name || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                                                <input required type="number" name="quantity" value={formData.quantity || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Low Stock Threshold</label>
                                                <input required type="number" name="low_stock_threshold" value={formData.low_stock_threshold || 5} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Cost Price</label>
                                                <input type="number" name="cost_price" value={formData.cost_price || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Selling Price</label>
                                                <input required type="number" name="sell_price" value={formData.sell_price || ''} onChange={handleInputChange} className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300" />
                                            </div>
                                        </div>
                                    </>
                                )}
                            </form>
                        </div>

                        <div className="px-6 py-4 border-t border-gray-100 flex justify-end space-x-3 bg-gray-50">
                            <button type="button" onClick={closeModal} className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-100 rounded-lg transition-colors">
                                Cancel
                            </button>
                            <button
                                type="submit"
                                form="add-form"
                                disabled={submitting}
                                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg shadow-md transition-colors"
                            >
                                {submitting ? 'Saving...' : editingItem ? 'Update Item' : 'Save Item'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}