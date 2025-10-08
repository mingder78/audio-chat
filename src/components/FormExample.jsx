import { useState } from 'react'
import { startLibp2pNode } from '../services/libp2p-services'
import '../App.css'

function FormExample() {
  // State for form input and the list of items
  const [formData, setFormData] = useState({ name: '' });
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);

  // Handle form input changes
  const handleInputChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      // Mock API call - replace with your actual API endpoint
      const response = await fetch('https://jsonplaceholder.typicode.com/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        throw new Error('Failed to submit form');
      }

      const result = await response.json();

      // Assuming the API returns the submitted data or a list
      // For this example, we'll mock a list response by adding the submitted data to the state
      setItems([...items, { id: Date.now(), ...formData }]);
      setFormData({ name: '' }); // Reset form
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="App">
      <h1>Submit Form and Display List</h1>

      {/* Form */}
      <form onSubmit={handleSubmit}>
        <label>
          Name:
          <input
            type="text"
            name="name"
            value={formData.name}
            onChange={handleInputChange}
            required
          />
        </label>
        <button type="submit">Submit</button>
      </form>

      {/* Error Message */}
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {/* Display List */}
      <h2>Submitted Items</h2>
      {items.length === 0 ? (
        <p>No items submitted yet.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default FormExample;
