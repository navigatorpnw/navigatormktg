import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

export default function Header() {
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  const navLinks = [
    { to: '/', label: 'Home' },
    { to: '/contact', label: 'Contact' },
  ]

  return (
    <header className="bg-gray-900 border-b-2 border-blue-500 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link to="/" className="text-2xl font-bold text-blue-400">
            Navigator PNW LLC
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex space-x-8">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`px-3 py-2 text-sm font-medium transition-colors ${
                  location.pathname === link.to
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-300 hover:text-blue-400'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Mobile menu button */}
          <button
            className="md:hidden text-gray-300"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>

        {/* Mobile nav */}
        {menuOpen && (
          <nav className="md:hidden pb-4 space-y-2">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setMenuOpen(false)}
                className={`block px-3 py-2 text-sm font-medium ${
                  location.pathname === link.to
                    ? 'text-blue-400'
                    : 'text-gray-300 hover:text-blue-400'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  )
}
